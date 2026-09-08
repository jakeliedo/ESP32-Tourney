// =============================================================
// jackpot.service.ts – Mystery Jackpot Engine (Real JP)
//
// Algorithm:
//  1. Each coin-in event contributes contributionRate% to pool
//  2. When pool crosses a secret PRNG hit_value, jackpot fires
//  3. AFT Cashable transfer sent directly to the triggering machine
//  4. Pool resets to floor; new hit_value generated in [floor, ceiling)
//
// Mode: only active when jackpot:mode = 'real' (Redis).
// configure() is called by the controller when operator updates settings.
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
  private floor: number;
  private ceiling: number;

  constructor(
    private cfg: ConfigService,
    private redis: RedisService,
    private mqtt: MqttGatewayService,
    private leaderboard: LeaderboardGateway,
    @InjectRepository(TransactionEntity)
    private transactions: Repository<TransactionEntity>,
  ) {}

  async onModuleInit() {
    // Load defaults from .env
    this.contributionRate = +this.cfg.get('JACKPOT_CONTRIBUTION_RATE', 0.5) / 100;
    this.floor   = +this.cfg.get('JACKPOT_BASE_AMOUNT', 10000);
    this.ceiling = +this.cfg.get('JACKPOT_MAX_AMOUNT', 1000000);

    // Override with saved config from Redis (persists across restarts)
    const f = await this.redis.get('jackpot:floor');
    const c = await this.redis.get('jackpot:ceiling');
    const r = await this.redis.get('jackpot:contrib_rate');
    if (f) this.floor   = parseInt(f);
    if (c) this.ceiling = parseInt(c);
    if (r) this.contributionRate = parseFloat(r);

    // Ensure pool and hit_value are initialised
    const pool = await this.redis.getJackpotPool();
    if (pool === 0) await this.redis.resetJackpotPool(this.floor);
    const hitValue = await this.redis.getJackpotHitValue();
    if (hitValue === 0) await this.generateNewHitValue();
  }

  // ── Called by controller when operator updates settings ───

  async configure(floor: number, ceiling: number, rate: number): Promise<void> {
    this.floor   = Math.max(1, Math.floor(floor));
    this.ceiling = Math.max(this.floor + 1, Math.floor(ceiling));
    this.contributionRate = Math.max(0, rate) / 100;

    await this.redis.set('jackpot:floor',        String(this.floor));
    await this.redis.set('jackpot:ceiling',      String(this.ceiling));
    await this.redis.set('jackpot:contrib_rate', String(this.contributionRate));

    // Reset pool and arm a new hit value
    await this.redis.resetJackpotPool(this.floor);
    await this.generateNewHitValue();
  }

  getConfig(): { floor: number; ceiling: number; rate: number } {
    return {
      floor:   this.floor,
      ceiling: this.ceiling,
      rate:    this.contributionRate * 100,
    };
  }

  // ── Called by Device Gateway for every coin-in event ─────

  async processCoinIn(machineId: string, coinInAmount: number): Promise<void> {
    // Only contribute when mode is 'real'
    const mode = await this.redis.get('jackpot:mode');
    if (mode === 'virtual') return;

    const contribution = coinInAmount * this.contributionRate;
    const newPool = await this.redis.incrementJackpotPool(contribution);
    const hitValue = await this.redis.getJackpotHitValue();

    if (newPool >= hitValue) {
      await this.triggerJackpot(machineId, Math.round(newPool));
    }
  }

  // ── Jackpot trigger ───────────────────────────────────────

  private async triggerJackpot(machineId: string, amount: number): Promise<void> {
    console.log(`🎰 JACKPOT HIT on ${machineId}: ${amount} credits ($${(amount / 100).toFixed(2)})`);

    const txn_id = uuidv4();

    await this.transactions.save({
      txn_id,
      machine_id: machineId,
      type: TransactionType.JACKPOT_CASHABLE,
      status: TransactionStatus.PENDING,
      amount,
    });

    this.mqtt.sendCommand(machineId, { type: 'AFT_PUMP', amount, txn_id });
    this.leaderboard.broadcastJackpotHit(machineId, amount);

    await this.redis.resetJackpotPool(this.floor);
    await this.generateNewHitValue();
  }

  // ── PRNG: hit value in [floor, ceiling) ──────────────────

  private async generateNewHitValue(): Promise<void> {
    const range    = this.ceiling - this.floor;
    const hitValue = this.floor + Math.floor(Math.random() * range);
    await this.redis.setJackpotHitValue(hitValue);
    console.log('New real jackpot hit value set (internal)');
  }

  async getPoolAmount(): Promise<number> {
    return this.redis.getJackpotPool();
  }
}
