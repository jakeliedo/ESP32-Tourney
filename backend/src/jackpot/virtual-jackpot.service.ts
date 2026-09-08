// =============================================================
// virtual-jackpot.service.ts – Virtual Progressive Jackpot Engine
//
// Algorithm:
//  1. Pool starts at floor when configured/reset
//  2. Each 2-second tick (while tournament ACTIVE): pool += tickIncrement
//     — constant, fixed credits per tick, independent of coin-in activity
//  3. A secret hit_value is drawn at random from [ceiling×0.8, ceiling)
//     at reset, so jackpot fires in the top 20% window near ceiling
//  4. When pool >= hit_value → jackpot fires → pool resets to floor
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
  private tickIncrement = 5;       // credits added per 2s tick (constant, no coin-in dependency)

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
    tickIncrement: number,  // credits added per 2s tick
    enabled: boolean,
  ): Promise<void> {
    this.floor         = Math.max(1, Math.floor(floor));
    this.ceiling       = Math.max(this.floor + 1, Math.floor(ceiling));
    this.tickIncrement = Math.max(0, Math.round(tickIncrement));
    this.enabled       = enabled;

    await this.redis.set('vjp:floor',          String(this.floor));
    await this.redis.set('vjp:ceiling',        String(this.ceiling));
    await this.redis.set('vjp:tick_increment', String(this.tickIncrement));
    await this.redis.set('vjp:enabled',        enabled ? 'true' : 'false');

    if (enabled) {
      await this.redis.set('vjp:pool', String(this.floor));
      await this.redis.set('vjp:hit',  String(this.newHitValue()));
      this.leaderboard.broadcastJackpotPool(this.floor);
    }
  }

  getConfig(): { floor: number; ceiling: number; tickIncrement: number; enabled: boolean } {
    return { floor: this.floor, ceiling: this.ceiling, tickIncrement: this.tickIncrement, enabled: this.enabled };
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
    this.enabled       = en === 'true';
    if (f)  this.floor         = parseInt(f);
    if (c)  this.ceiling       = parseInt(c);
    if (ti) this.tickIncrement = parseInt(ti);
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

    // Constant increment — no coin-in dependency
    const poolStr = await this.redis.get('vjp:pool');
    let pool = poolStr ? parseFloat(poolStr) : this.floor;
    pool += this.tickIncrement;

    const hitStr = await this.redis.get('vjp:hit');
    const hit    = hitStr ? parseInt(hitStr) : this.ceiling;

    if (pool >= hit) {
      const rankings = await this.redis.getLeaderboard(active.id);
      const winner   = rankings[0]?.machineId ?? 'VIRTUAL';
      const amount   = Math.round(pool);
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
      await this.redis.set('vjp:hit', String(this.newHitValue()));
    }

    await this.redis.set('vjp:pool', String(pool));
    this.leaderboard.broadcastJackpotPool(Math.round(pool));
  }

  // Hit value drawn from top 20% of [floor, ceiling) — fires near ceiling
  private newHitValue(): number {
    const low = Math.floor(this.ceiling * 0.8);
    const high = this.ceiling;
    return Math.floor(low + Math.random() * (high - low));
  }
}
