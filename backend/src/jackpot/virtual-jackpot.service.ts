// =============================================================
// virtual-jackpot.service.ts – Virtual Progressive Jackpot Engine
//
// Algorithm (2026-09-09 redesign):
//  1. Each round (tournament) is auto-detected the first tick after it goes
//     ACTIVE (by tournament id changing) — pool resets to floor and a
//     schedule of `numHits` target fire-times is drawn: each an
//     INDEPENDENT random point within the round's own duration_seconds
//     (small buffer at each end so a hit never lands in literally the
//     first/last couple seconds). This guarantees the jackpot fires
//     exactly `numHits` times during THIS round, tied to its real
//     duration -- not "maybe, if the numbers happen to line up" like the
//     old design (random hit_value near `ceiling`, no relationship to
//     timing at all).
//  2. Each 2-second tick (while tournament ACTIVE): pool += a RANDOM
//     amount between 1 and tickIncrement (inclusive). tickIncrement is a
//     per-tick CAP now, not an exact amount -- a perfectly fixed step
//     every 2s looks mechanically fake; a randomized-but-bounded step
//     looks organic while staying fully operator-controlled.
//  3. Whenever elapsed round-time crosses the next scheduled target: fire
//     immediately with whatever the pool has organically reached (clamped
//     to [floor, ceiling]), reset pool to floor, advance to the next
//     scheduled target (if any left this round).
//
// Mode: only ticks when jackpot:mode = 'virtual' (Redis).
// =============================================================
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { RedisService } from '../redis/redis.module';
import { LeaderboardGateway } from '../device-gateway/leaderboard.gateway';
import { TournamentEntity, TournamentStatus } from '../database/entities/tournament.entity';
import { JackpotHitEntity } from '../database/entities/jackpot_hit.entity';

@Injectable()
export class VirtualJackpotService implements OnModuleInit, OnModuleDestroy {
  private ticker: ReturnType<typeof setInterval> | null = null;

  private enabled       = false;
  private floor         = 10000;   // credits = $100.00
  private ceiling       = 30000;   // credits = $300.00
  private tickIncrement = 5;       // per-tick CAP -- actual increment is random(1..this) each tick
  private numHits       = 1;       // guaranteed jackpot hits per round

  constructor(
    private redis: RedisService,
    private leaderboard: LeaderboardGateway,
    @InjectRepository(TournamentEntity)
    private tournaments: Repository<TournamentEntity>,
    @InjectRepository(JackpotHitEntity)
    private jackpotHits: Repository<JackpotHitEntity>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.loadConfig();
    this.ticker = setInterval(() => this.tick().catch(() => {}), 2000);
  }

  onModuleDestroy(): void {
    if (this.ticker) clearInterval(this.ticker);
  }

  // ── Called by controller when operator configures the engine ─

  async configure(
    floor: number,
    ceiling: number,
    tickIncrement: number,  // max credits added per 2s tick
    numHits: number,        // guaranteed jackpot hits per round
    enabled: boolean,
  ): Promise<void> {
    this.floor         = Math.max(1, Math.floor(floor));
    this.ceiling       = Math.max(this.floor + 1, Math.floor(ceiling));
    this.tickIncrement = Math.max(1, Math.round(tickIncrement));
    this.numHits       = Math.max(1, Math.round(numHits));
    this.enabled       = enabled;

    await this.redis.set('vjp:floor',          String(this.floor));
    await this.redis.set('vjp:ceiling',        String(this.ceiling));
    await this.redis.set('vjp:tick_increment', String(this.tickIncrement));
    await this.redis.set('vjp:num_hits',       String(this.numHits));
    await this.redis.set('vjp:enabled',        enabled ? 'true' : 'false');

    if (enabled) {
      await this.redis.set('vjp:pool', String(this.floor));
      this.leaderboard.broadcastJackpotPool(this.floor);
      // Don't draw a schedule here -- at configure() time (called right
      // before a tournament is created, see App.tsx's handleStart()) we
      // don't yet reliably know the round's real started_at/duration_seconds.
      // Clearing the "armed" marker makes tick() treat the next active
      // tournament it sees as a fresh round and draw a proper schedule for
      // it (see the round-detection block in tick()).
      await this.redis.del('vjp:armed_tournament_id');
    }
  }

  getConfig(): { floor: number; ceiling: number; tickIncrement: number; numHits: number; enabled: boolean } {
    return {
      floor: this.floor, ceiling: this.ceiling,
      tickIncrement: this.tickIncrement, numHits: this.numHits,
      enabled: this.enabled,
    };
  }

  async getPool(): Promise<number> {
    const v = await this.redis.get('vjp:pool');
    return v ? Math.round(parseFloat(v)) : this.floor;
  }

  // ── Internal helpers ─────────────────────────────────────────

  private async loadConfig(): Promise<void> {
    const en = await this.redis.get('vjp:enabled');
    const f  = await this.redis.get('vjp:floor');
    const c  = await this.redis.get('vjp:ceiling');
    const ti = await this.redis.get('vjp:tick_increment');
    const nh = await this.redis.get('vjp:num_hits');
    this.enabled       = en === 'true';
    if (f)  this.floor         = parseInt(f);
    if (c)  this.ceiling       = parseInt(c);
    if (ti) this.tickIncrement = parseInt(ti);
    if (nh) this.numHits       = parseInt(nh);
  }

  private async tick(): Promise<void> {
    // Only run when mode = 'virtual'
    const mode = await this.redis.get('jackpot:mode');
    if (mode === 'real') return;
    if (!this.enabled) return;

    const active = await this.tournaments.findOne({
      where: { status: TournamentStatus.ACTIVE },
      order: { id: 'DESC' },
    });
    if (!active) return;

    // ── Round detection: draw a fresh, time-constrained hit schedule the
    // first tick that sees THIS tournament id as active (new round, or
    // first tick after configure() cleared the marker).
    const armedId = await this.redis.get('vjp:armed_tournament_id');
    let pool: number;
    let targets: number[];
    let hitIdx: number;

    if (armedId !== String(active.id)) {
      pool    = this.floor;
      targets = this.scheduleTargets(active.duration_seconds);
      hitIdx  = 0;
      await this.redis.set('vjp:armed_tournament_id', String(active.id));
      await this.redis.set('vjp:targets', JSON.stringify(targets));
      await this.redis.set('vjp:hit_idx', '0');
      await this.redis.set('vjp:pool', String(pool));
      this.leaderboard.broadcastJackpotPool(pool);
    } else {
      const poolStr = await this.redis.get('vjp:pool');
      pool = poolStr ? parseFloat(poolStr) : this.floor;
      const targetsStr = await this.redis.get('vjp:targets');
      targets = targetsStr ? JSON.parse(targetsStr) : [];
      const idxStr = await this.redis.get('vjp:hit_idx');
      hitIdx = idxStr ? parseInt(idxStr) : 0;
    }

    // Random per-tick increment capped at tickIncrement -- deliberately
    // irregular so the displayed number doesn't look mechanically fixed.
    const inc = 1 + Math.floor(Math.random() * this.tickIncrement);
    pool = Math.min(pool + inc, this.ceiling);

    if (hitIdx < targets.length && active.started_at) {
      const elapsedSec = (Date.now() - new Date(active.started_at).getTime()) / 1000;
      if (elapsedSec >= targets[hitIdx]) {
        const rankings = await this.redis.getLeaderboard(active.id);
        const winner   = rankings[0]?.machineId ?? 'VIRTUAL';
        const amount   = Math.round(Math.max(pool, this.floor));
        console.log(`🎰 Virtual Jackpot HIT — ${winner}: $${(amount / 100).toFixed(2)}`);
        await this.jackpotHits.save({
          machine_id:    winner,
          amount,
          tournament_id: active.id,
          session_id:    active.session_id ?? null,
        });
        const videoUrl = await this.redis.get('vjp:video_url');
        this.leaderboard.broadcastJackpotHit(winner, amount, videoUrl || null);
        pool = this.floor;
        hitIdx += 1;
        await this.redis.set('vjp:hit_idx', String(hitIdx));
      }
    }

    await this.redis.set('vjp:pool', String(pool));
    this.leaderboard.broadcastJackpotPool(Math.round(pool));
  }

  // `numHits` independent random target times (elapsed seconds from round
  // start), spread across the WHOLE round -- not evenly-spaced segments --
  // with a small buffer at each end so a hit doesn't fire in literally the
  // first/last couple seconds. Sorted so tick() can check them in order.
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
}
