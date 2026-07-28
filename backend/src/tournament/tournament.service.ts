// =============================================================
// tournament.service.ts – Tournament Engine
//
// Phase 1: Pump restricted credits to all machines → lock cashout
// Phase 2: Real-time score accumulation via Redis sorted set
// Phase 3: Cleanup – withdraw remaining credits, unlock machines
// =============================================================
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { TournamentEntity, TournamentStatus } from '../database/entities/tournament.entity';
import { TransactionEntity, TransactionType, TransactionStatus } from '../database/entities/transaction.entity';
import { RedisService } from '../redis/redis.module';
import { MqttGatewayService } from '../device-gateway/mqtt-gateway.service';
import { LeaderboardGateway } from '../device-gateway/leaderboard.gateway';

export interface CreateTournamentDto {
  name: string;
  machine_ids: string[];
  initial_credits: number;
  duration_seconds: number;
}

@Injectable()
export class TournamentService {
  constructor(
    @InjectRepository(TournamentEntity)
    private tournaments: Repository<TournamentEntity>,
    @InjectRepository(TransactionEntity)
    private transactions: Repository<TransactionEntity>,
    private redis: RedisService,
    private mqtt: MqttGatewayService,
    private leaderboard: LeaderboardGateway,
  ) {}

  async create(dto: CreateTournamentDto): Promise<TournamentEntity> {
    const t = this.tournaments.create(dto);
    return this.tournaments.save(t);
  }

  async findAll(): Promise<TournamentEntity[]> {
    return this.tournaments.find({ order: { created_at: 'DESC' } });
  }

  async findOne(id: number): Promise<TournamentEntity> {
    const t = await this.tournaments.findOneBy({ id });
    if (!t) throw new NotFoundException(`Tournament ${id} not found`);
    return t;
  }

  // ── Phase 1: Start tournament ─────────────────────────────

  async start(id: number): Promise<void> {
    const t = await this.findOne(id);
    if (t.status !== TournamentStatus.SCHEDULED) {
      throw new Error(`Tournament ${id} is not in SCHEDULED state`);
    }

    // Lock machines and pump restricted credits via MQTT → ESP32 → AFT 72
    for (const machineId of t.machine_ids) {
      // Step A: Lock cashout
      this.mqtt.sendCommand(machineId, { type: 'LOCK' });
      await this.delay(200);

      // Step B: Pump restricted credits (AFT transfer type: RESTRICTED)
      const txn_id = uuidv4();
      await this.transactions.save({
        txn_id,
        machine_id: machineId,
        type: TransactionType.TOURNAMENT_PUMP,
        status: TransactionStatus.PENDING,
        amount: t.initial_credits,
        tournament_id: id,
      });
      this.mqtt.sendCommand(machineId, {
        type: 'AFT_PUMP',
        amount: t.initial_credits,
        txn_id,
      });

      // Initialize Redis score for this machine
      await this.redis.updateScore(id, machineId, 0);
    }

    await this.tournaments.update(id, {
      status: TournamentStatus.ACTIVE,
      started_at: new Date(),
    });

    // Auto-end after duration
    setTimeout(() => this.end(id), t.duration_seconds * 1000);
    console.log(`Tournament ${id} started with ${t.machine_ids.length} machines`);
  }

  // ── Phase 2: Update score for a machine ──────────────────

  async updateScore(tournamentId: number, machineId: string, winAmount: number): Promise<void> {
    // Increment score in Redis sorted set
    await this.redis.client?.zincrby(
      `tourney:${tournamentId}:scores`, winAmount, machineId,
    ).catch(() => null);

    // Push updated leaderboard to all WebSocket clients
    const rankings = await this.redis.getLeaderboard(tournamentId);
    this.leaderboard.broadcastLeaderboard(tournamentId, rankings);
  }

  async getLeaderboard(id: number) {
    return this.redis.getLeaderboard(id);
  }

  // ── Phase 3: End tournament ───────────────────────────────

  async end(id: number): Promise<void> {
    const t = await this.findOne(id);
    if (t.status !== TournamentStatus.ACTIVE) return;

    for (const machineId of t.machine_ids) {
      // Withdraw remaining restricted credits (AFT withdraw)
      const txn_id = uuidv4();
      await this.transactions.save({
        txn_id,
        machine_id: machineId,
        type: TransactionType.TOURNAMENT_WITHDRAW,
        status: TransactionStatus.PENDING,
        amount: 0,  // withdraw all remaining
        tournament_id: id,
      });
      this.mqtt.sendCommand(machineId, { type: 'AFT_WITHDRAW', amount: 0, txn_id });
      await this.delay(200);

      // Unlock machine
      this.mqtt.sendCommand(machineId, { type: 'UNLOCK' });
    }

    await this.tournaments.update(id, {
      status: TournamentStatus.FINISHED,
      ended_at: new Date(),
    });
    console.log(`Tournament ${id} ended`);
  }

  private delay(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
