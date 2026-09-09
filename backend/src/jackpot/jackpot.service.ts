// =============================================================
// jackpot.service.ts – Mystery Jackpot Engine (Real JP)
//
// Algorithm (2026-09-09 redesign, mirrors VirtualJackpotService):
//  1. Pool grows from real coin-in (contributionRate % of each wager) via
//     processCoinIn() -- unchanged, still genuinely reflects real play.
//  2. Each round (tournament) is auto-detected by a periodic 2s check
//     (checkSchedule()) the same way Virtual JP does -- pool resets to
//     floor and a schedule of `numHits` target fire-times is drawn: each
//     an INDEPENDENT random point within the round's own duration_seconds.
//     This guarantees exactly `numHits` real jackpots fire during THIS
//     round, regardless of how much actual coin-in happens to occur --
//     coin-in alone can't reliably trigger a "time has passed" check, so a
//     real jackpot needs this same clock-driven safety net Virtual JP has.
//  3. Whenever elapsed round-time crosses the next scheduled target: fire
//     immediately with whatever the pool has organically accrued from real
//     coin-in (clamped to [floor, ceiling]), reset pool to floor, advance
//     to the next scheduled target (if any left this round).
//
// Mode: only active when jackpot:mode = 'real' (Redis).
// configure() is called by the controller when operator updates settings.
// =============================================================
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { RedisService } from '../redis/redis.module';
import { MqttGatewayService } from '../device-gateway/mqtt-gateway.service';
import { LeaderboardGateway } from '../device-gateway/leaderboard.gateway';
import { TransactionEntity, TransactionType, TransactionStatus } from '../database/entities/transaction.entity';
import { TournamentEntity, TournamentStatus } from '../database/entities/tournament.entity';
import { JackpotHitEntity } from '../database/entities/jackpot_hit.entity';

@Injectable()
export class JackpotService implements OnModuleInit, OnModuleDestroy {
  private ticker: ReturnType<typeof setInterval> | null = null;

  private contributionRate: number;
  private floor: number;
  private ceiling: number;
  private numHits = 1;   // guaranteed jackpot hits per round

  constructor(
    private cfg: ConfigService,
    private redis: RedisService,
    private mqtt: MqttGatewayService,
    private leaderboard: LeaderboardGateway,
    @InjectRepository(TransactionEntity)
    private transactions: Repository<TransactionEntity>,
    @InjectRepository(TournamentEntity)
    private tournaments: Repository<TournamentEntity>,
    @InjectRepository(JackpotHitEntity)
    private jackpotHits: Repository<JackpotHitEntity>,
  ) {}

  async onModuleInit() {
    // Load defaults from .env
    this.contributionRate = +this.cfg.get('JACKPOT_CONTRIBUTION_RATE', 0.5) / 100;
    this.floor   = +this.cfg.get('JACKPOT_BASE_AMOUNT', 10000);
    this.ceiling = +this.cfg.get('JACKPOT_MAX_AMOUNT', 1000000);

    // Override with saved config from Redis (persists across restarts)
    const f  = await this.redis.get('jackpot:floor');
    const c  = await this.redis.get('jackpot:ceiling');
    const r  = await this.redis.get('jackpot:contrib_rate');
    const nh = await this.redis.get('jackpot:num_hits');
    if (f)  this.floor            = parseInt(f);
    if (c)  this.ceiling          = parseInt(c);
    if (r)  this.contributionRate = parseFloat(r);
    if (nh) this.numHits          = parseInt(nh);

    // Ensure pool is initialised
    const pool = await this.redis.getJackpotPool();
    if (pool === 0) await this.redis.resetJackpotPool(this.floor);

    this.ticker = setInterval(() => this.checkSchedule().catch(() => {}), 2000);
  }

  onModuleDestroy(): void {
    if (this.ticker) clearInterval(this.ticker);
  }

  // ── Called by controller when operator updates settings ───

  async configure(floor: number, ceiling: number, rate: number, numHits: number): Promise<void> {
    this.floor            = Math.max(1, Math.floor(floor));
    this.ceiling           = Math.max(this.floor + 1, Math.floor(ceiling));
    this.contributionRate  = Math.max(0, rate) / 100;
    this.numHits            = Math.max(1, Math.round(numHits));

    await this.redis.set('jackpot:floor',        String(this.floor));
    await this.redis.set('jackpot:ceiling',      String(this.ceiling));
    await this.redis.set('jackpot:contrib_rate', String(this.contributionRate));
    await this.redis.set('jackpot:num_hits',     String(this.numHits));

    // Reset pool; clear the "armed" marker so checkSchedule() draws a fresh
    // schedule the next time it sees an active tournament (see comment in
    // VirtualJackpotService.configure() for why this can't happen here --
    // we don't yet reliably know the round's real duration_seconds).
    await this.redis.resetJackpotPool(this.floor);
    await this.redis.del('jackpot:armed_tournament_id');
  }

  getConfig(): { floor: number; ceiling: number; rate: number; numHits: number } {
    return {
      floor:   this.floor,
      ceiling: this.ceiling,
      rate:    this.contributionRate * 100,
      numHits: this.numHits,
    };
  }

  // ── Called by Device Gateway for every coin-in event ─────

  async processCoinIn(machineId: string, coinInAmount: number): Promise<void> {
    // Only contribute when mode is 'real' AND a tournament is currently running
    const mode = await this.redis.get('jackpot:mode');
    if (mode === 'virtual') return;

    const active = await this.tournaments.findOne({
      where: { status: TournamentStatus.ACTIVE },
      order: { id: 'DESC' },
    });
    if (!active) return;

    // Pool only accrues here -- firing is schedule-driven (see
    // checkSchedule()), not threshold-driven, so the jackpot is guaranteed
    // to land within the round regardless of how much coin-in occurs.
    const contribution = coinInAmount * this.contributionRate;
    await this.redis.incrementJackpotPool(contribution);
  }

  // ── Scheduled firing (2s tick, mirrors VirtualJackpotService.tick()) ──

  private async checkSchedule(): Promise<void> {
    const mode = await this.redis.get('jackpot:mode');
    if (mode === 'virtual') return;

    const active = await this.tournaments.findOne({
      where: { status: TournamentStatus.ACTIVE },
      order: { id: 'DESC' },
    });
    if (!active) return;

    const armedId = await this.redis.get('jackpot:armed_tournament_id');
    let targets: number[];
    let hitIdx: number;

    if (armedId !== String(active.id)) {
      targets = this.scheduleTargets(active.duration_seconds);
      hitIdx  = 0;
      await this.redis.set('jackpot:armed_tournament_id', String(active.id));
      await this.redis.set('jackpot:targets', JSON.stringify(targets));
      await this.redis.set('jackpot:hit_idx', '0');
      await this.redis.resetJackpotPool(this.floor);
    } else {
      const targetsStr = await this.redis.get('jackpot:targets');
      targets = targetsStr ? JSON.parse(targetsStr) : [];
      const idxStr = await this.redis.get('jackpot:hit_idx');
      hitIdx = idxStr ? parseInt(idxStr) : 0;
    }

    if (hitIdx >= targets.length || !active.started_at) return;

    const elapsedSec = (Date.now() - new Date(active.started_at).getTime()) / 1000;
    if (elapsedSec < targets[hitIdx]) return;

    const pool   = await this.redis.getJackpotPool();
    const amount = Math.round(Math.min(Math.max(pool, this.floor), this.ceiling));

    const rankings = await this.redis.getLeaderboard(active.id);
    const winner   = rankings[0]?.machineId ?? 'REAL';

    await this.triggerJackpot(winner, amount, active.id, active.session_id ?? null);
    await this.redis.set('jackpot:hit_idx', String(hitIdx + 1));
  }

  // ── Jackpot trigger ───────────────────────────────────────

  private async triggerJackpot(
    machineId: string, amount: number,
    tournamentId?: number, sessionId?: string | null,
  ): Promise<void> {
    console.log(`🎰 JACKPOT HIT on ${machineId}: ${amount} credits ($${(amount / 100).toFixed(2)})`);

    const txn_id = uuidv4();

    await this.transactions.save({
      txn_id,
      machine_id: machineId,
      type: TransactionType.JACKPOT_CASHABLE,
      status: TransactionStatus.PENDING,
      amount,
    });

    await this.jackpotHits.save({
      machine_id:    machineId,
      amount,
      tournament_id: tournamentId ?? null,
      session_id:    sessionId ?? null,
    });

    this.mqtt.sendCommand(machineId, { type: 'AFT_PUMP', amount, txn_id });
    const videoUrl = await this.redis.get('vjp:video_url');
    this.leaderboard.broadcastJackpotHit(machineId, amount, videoUrl || null);

    await this.redis.resetJackpotPool(this.floor);
  }

  // `numHits` independent random target times (elapsed seconds from round
  // start), spread across the WHOLE round -- not evenly-spaced segments --
  // with a small buffer at each end. Sorted so checkSchedule() can check
  // them in order via hitIdx. Identical algorithm to
  // VirtualJackpotService.scheduleTargets() -- kept duplicated rather than
  // shared since the two services are otherwise fully independent.
  private scheduleTargets(durationSeconds: number): number[] {
    const buffer = Math.min(3, durationSeconds / 4);
    const lo = buffer;
    const hi = Math.max(lo + 1, durationSeconds - buffer);
    const targets: number[] = [];
    for (let i = 0; i < this.numHits; i++) {
      targets.push(lo + Math.random() * (hi - lo));
    }
    return targets.sort((a, b) => a - b);
  }

  async getPoolAmount(): Promise<number> {
    return this.redis.getJackpotPool();
  }
}
