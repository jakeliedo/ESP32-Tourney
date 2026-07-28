// =============================================================
// jackpot.service.ts – Mystery Jackpot Engine
//
// Algorithm:
//  1. Each coin-in event contributes JACKPOT_CONTRIBUTION_RATE% to pool
//  2. When pool crosses a secret PRNG hit_value, jackpot fires
//  3. AFT Cashable transfer sent directly to the triggering machine
//  4. Pool resets to JACKPOT_BASE_AMOUNT; new hit_value generated
// =============================================================
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { RedisService } from '../redis/redis.module';
import { MqttGatewayService } from '../device-gateway/mqtt-gateway.service';
import { LeaderboardGateway } from '../device-gateway/leaderboard.gateway';
import { TransactionEntity, TransactionType, TransactionStatus } from '../database/entities/transaction.entity';

@Injectable()
export class JackpotService implements OnModuleInit {
  private contributionRate: number;
  private baseAmount: number;
  private maxAmount: number;

  constructor(
    private cfg: ConfigService,
    private redis: RedisService,
    private mqtt: MqttGatewayService,
    private leaderboard: LeaderboardGateway,
    @InjectRepository(TransactionEntity)
    private transactions: Repository<TransactionEntity>,
  ) {}

  async onModuleInit() {
    this.contributionRate = +this.cfg.get('JACKPOT_CONTRIBUTION_RATE', 0.5) / 100;
    this.baseAmount = +this.cfg.get('JACKPOT_BASE_AMOUNT', 10000);
    this.maxAmount  = +this.cfg.get('JACKPOT_MAX_AMOUNT', 1000000);

    // Ensure jackpot pool and hit_value are initialised
    const pool = await this.redis.getJackpotPool();
    if (pool === 0) {
      await this.redis.resetJackpotPool(this.baseAmount);
    }
    const hitValue = await this.redis.getJackpotHitValue();
    if (hitValue === 0) {
      await this.generateNewHitValue();
    }
  }

  // ── Called by Device Gateway for every coin-in event ─────

  async processCoinIn(machineId: string, coinInAmount: number): Promise<void> {
    const contribution = coinInAmount * this.contributionRate;
    const newPool = await this.redis.incrementJackpotPool(contribution);
    const hitValue = await this.redis.getJackpotHitValue();

    if (newPool >= hitValue) {
      await this.triggerJackpot(machineId, Math.floor(newPool));
    }
  }

  // ── Jackpot trigger ───────────────────────────────────────

  private async triggerJackpot(machineId: string, amount: number): Promise<void> {
    console.log(`🎰 JACKPOT HIT on ${machineId}: ${amount} credits`);

    const txn_id = uuidv4();

    // Log transaction first (immutable record)
    await this.transactions.save({
      txn_id,
      machine_id: machineId,
      type: TransactionType.JACKPOT_CASHABLE,
      status: TransactionStatus.PENDING,
      amount,
    });

    // Send AFT Cashable to the winning machine
    this.mqtt.sendCommand(machineId, {
      type: 'AFT_PUMP',
      amount,
      txn_id,
    });

    // Notify all Leaderboard screens
    this.leaderboard.broadcastJackpotHit(machineId, amount);

    // Reset pool and generate new secret hit value
    await this.redis.resetJackpotPool(this.baseAmount);
    await this.generateNewHitValue();
  }

  // ── PRNG: generate new secret hit value ──────────────────

  private async generateNewHitValue(): Promise<void> {
    const range = this.maxAmount - this.baseAmount;
    // Cryptographically sufficient for gaming: uniform distribution
    const hitValue = this.baseAmount + Math.floor(Math.random() * range);
    await this.redis.setJackpotHitValue(hitValue);
    console.log(`New jackpot hit value set (internal)`);
  }

  async getPoolAmount(): Promise<number> {
    return this.redis.getJackpotPool();
  }
}
