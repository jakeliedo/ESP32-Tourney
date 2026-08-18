// =============================================================
// tournament.service.ts – Tournament Engine
//
// Phase 1: Pump restricted credits to all machines → lock cashout
// Phase 2: Real-time score accumulation via Redis sorted set
// Phase 3: Cleanup – withdraw remaining credits, unlock machines
// =============================================================
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

// ── History DTOs ──────────────────────────────────────────────
export interface RoundResultDto {
  rank: number;
  machineId: string;
  playerDisplay: string;
  finalScore: number;
}

export interface RoundDto {
  tournamentId: number;
  roundNumber: number;
  totalRounds: number;
  durationSeconds: number;
  machineCount: number;
  endedAt: string;
  results: RoundResultDto[];
}

export interface SessionDto {
  sessionId: string;
  date: string;
  sessionName: string;
  rounds: RoundDto[];
}

import { TournamentEntity, TournamentStatus } from '../database/entities/tournament.entity';
import { TransactionEntity } from '../database/entities/transaction.entity';
import { MachineEntity, MachineStatus } from '../database/entities/machine.entity';
import { RoundResultEntity } from '../database/entities/round_result.entity';
import { RedisService } from '../redis/redis.module';
import { MqttGatewayService } from '../device-gateway/mqtt-gateway.service';
import { LeaderboardGateway } from '../device-gateway/leaderboard.gateway';

export interface CreateTournamentDto {
  name: string;
  machine_ids: string[];
  initial_credits: number;
  duration_seconds: number;
  session_id?: string;
  session_name?: string;
  round_number?: number;
  total_rounds?: number;
}

@Injectable()
export class TournamentService {
  constructor(
    @InjectRepository(TournamentEntity)
    private tournaments: Repository<TournamentEntity>,
    @InjectRepository(TransactionEntity)
    private transactions: Repository<TransactionEntity>,
    @InjectRepository(MachineEntity)
    private machines: Repository<MachineEntity>,
    @InjectRepository(RoundResultEntity)
    private roundResults: Repository<RoundResultEntity>,
    private redis: RedisService,
    private mqtt: MqttGatewayService,
    private leaderboard: LeaderboardGateway,
  ) {}

  async create(dto: CreateTournamentDto): Promise<TournamentEntity> {
    const t = this.tournaments.create({
      ...dto,
      round_number: dto.round_number ?? 1,
      total_rounds: dto.total_rounds ?? 1,
    });
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

    // Enable all machines; init leaderboard scores from current credits in DB
    for (const machineId of t.machine_ids) {
      this.mqtt.sendCommand(machineId, { type: 'ENABLE' });
      await this.delay(100);
      const machine = await this.machines.findOneBy({ machine_id: machineId });
      await this.redis.updateScore(id, machineId, machine?.credits ?? 0);
    }

    await this.tournaments.update(id, {
      status: TournamentStatus.ACTIVE,
      started_at: new Date(),
    });

    // Broadcast initial leaderboard so frontend resets immediately
    const initialRankings = await this.redis.getLeaderboard(id);
    const endsAt = Date.now() + t.duration_seconds * 1000;
    this.leaderboard.broadcastLeaderboard(id, initialRankings, t.round_number, t.total_rounds, endsAt);

    // Auto-end after duration (server-side safety net)
    setTimeout(() => this.end(id), t.duration_seconds * 1000);
    console.log(`Tournament ${id} started with ${t.machine_ids.length} machines`);
  }

  // ── Phase 2: Update score for a machine ──────────────────

  async updateScore(tournamentId: number, machineId: string, winAmount: number): Promise<void> {
    // Increment score in Redis sorted set
    await this.redis.incrementScore(tournamentId, machineId, winAmount);

    // Push updated leaderboard to all WebSocket clients
    const rankings = await this.redis.getLeaderboard(tournamentId);
    this.leaderboard.broadcastLeaderboard(tournamentId, rankings);
  }

  async getLeaderboard(id: number) {
    return this.redis.getLeaderboard(id);
  }

  // ── Phase 3: End tournament ───────────────────────────────

  async end(id: number): Promise<void> {
    // Atomic status flip — only one concurrent caller wins; the other sees affected=0 and exits.
    const flip = await this.tournaments.update(
      { id, status: TournamentStatus.ACTIVE },
      { status: TournamentStatus.FINISHED, ended_at: new Date() },
    );
    if (!flip.affected) return;

    const t = await this.findOne(id);

    // Disable all machines — update DB immediately so control panel reflects
    // the change on next poll without waiting for MQTT telemetry round-trip.
    for (const machineId of t.machine_ids) {
      this.mqtt.sendCommand(machineId, { type: 'DISABLE' });
      await this.machines.update({ machine_id: machineId }, { status: MachineStatus.DISABLED });
      await this.delay(100);
    }

    // Sync latest credits from DB → Redis (Redis may lag if telemetry skipped identical values)
    const machineCache = new Map<string, MachineEntity>();
    for (const machineId of t.machine_ids) {
      const machine = await this.machines.findOneBy({ machine_id: machineId });
      if (machine) {
        await this.redis.updateScore(id, machineId, machine.credits);
        machineCache.set(machineId, machine);
      }
    }

    // Save final standings as round results
    const finalRankings = await this.redis.getLeaderboard(id);
    for (let i = 0; i < finalRankings.length; i++) {
      const entry = finalRankings[i] as { machineId: string; score: number };
      const machine = machineCache.get(entry.machineId);
      await this.roundResults.save(
        this.roundResults.create({
          tournament_id: id,
          machine_id: entry.machineId,
          player_display: machine?.display_name || entry.machineId,
          final_score: entry.score,
          rank: i + 1,
          session_id: t.session_id,
          round_number: t.round_number,
          total_rounds: t.total_rounds,
        }),
      );
    }

    // Broadcast final leaderboard — endsAt=0 signals tournament is over
    this.leaderboard.broadcastLeaderboard(id, finalRankings, t.round_number, t.total_rounds, 0);
    console.log(`Tournament ${id} ended`);
  }

  async cancel(id: number): Promise<void> {
    // Atomic flip — prevents race with the server-side setTimeout end()
    const flip = await this.tournaments.update(
      { id, status: TournamentStatus.ACTIVE },
      { status: TournamentStatus.CANCELLED, ended_at: new Date() },
    );
    if (!flip.affected) return;

    const t = await this.findOne(id);

    for (const machineId of t.machine_ids) {
      this.mqtt.sendCommand(machineId, { type: 'DISABLE' });
      await this.machines.update({ machine_id: machineId }, { status: MachineStatus.DISABLED });
      await this.delay(100);
    }

    // Signal leaderboard to exit tournament mode — no results saved
    this.leaderboard.broadcastLeaderboard(id, [], t.round_number, t.total_rounds, 0);
    console.log(`Tournament ${id} cancelled (no results saved)`);
  }

  async nextRound(id: number): Promise<TournamentEntity> {
    const current = await this.findOne(id);
    const next = this.tournaments.create({
      name: current.name,
      machine_ids: current.machine_ids,
      initial_credits: current.initial_credits,
      duration_seconds: current.duration_seconds,
      session_id: current.session_id,
      session_name: current.session_name,
      round_number: current.round_number + 1,
      total_rounds: current.total_rounds,
    });
    return this.tournaments.save(next);
  }

  async getHistory(): Promise<SessionDto[]> {
    // Load all finished tournaments newest-first
    const all = await this.tournaments.find({
      where: { status: TournamentStatus.FINISHED },
      order: { ended_at: 'DESC' },
    });

    // Group by session_id; standalone rounds (null session_id) get a synthetic key
    const sessionMap = new Map<string, typeof all>();
    for (const t of all) {
      const key = t.session_id || `solo-${t.id}`;
      if (!sessionMap.has(key)) sessionMap.set(key, []);
      sessionMap.get(key)!.push(t);
    }

    // Sort sessions by most-recent ended_at, keep 5
    const sessions = [...sessionMap.entries()]
      .map(([key, rounds]) => ({
        key,
        lastEnded: Math.max(...rounds.map(r => r.ended_at ? new Date(r.ended_at).getTime() : 0)),
        rounds: [...rounds].sort((a, b) => (a.round_number ?? 1) - (b.round_number ?? 1)),
      }))
      .sort((a, b) => b.lastEnded - a.lastEnded)
      .slice(0, 8);

    // Bulk-load round_results for all relevant tournament IDs
    const ids = sessions.flatMap(s => s.rounds.map(r => r.id));
    const allResults = ids.length
      ? await this.roundResults.find({
          where: { tournament_id: In(ids) },
          order: { tournament_id: 'ASC', rank: 'ASC' },
        })
      : [];

    const byTournament = new Map<number, RoundResultEntity[]>();
    for (const r of allResults) {
      if (!byTournament.has(r.tournament_id)) byTournament.set(r.tournament_id, []);
      byTournament.get(r.tournament_id)!.push(r);
    }

    return sessions.map(({ key, lastEnded, rounds }) => ({
      sessionId: key,
      date: new Date(lastEnded).toLocaleDateString('en-GB'),
      sessionName: rounds[0]?.session_name || new Date(lastEnded).toLocaleDateString('en-GB'),
      rounds: rounds.map(t => ({
        tournamentId: t.id,
        roundNumber: t.round_number ?? 1,
        totalRounds: t.total_rounds ?? 1,
        durationSeconds: t.duration_seconds,
        machineCount: t.machine_ids?.length ?? 0,
        endedAt: t.ended_at ? new Date(t.ended_at).toISOString() : '',
        results: (byTournament.get(t.id) ?? []).map(r => ({
          rank: r.rank,
          machineId: r.machine_id,
          playerDisplay: r.player_display || r.machine_id,
          finalScore: Number(r.final_score),
        })),
      })),
    }));
  }

  private delay(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
