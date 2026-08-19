// =============================================================
// virtual-jackpot.service.ts – Virtual Progressive Jackpot Engine
//
// Algorithm (mirrors real casino progressive jackpots):
//  1. Pool starts at `floor` when a tournament round begins
//  2. Each 2-second tick: compute coin_in delta across all machines
//  3. contribution = Σ(coin_in_delta) × rate  (e.g. 1% of coins wagered)
//  4. Pool grows by contribution each tick
//  5. A secret hit_value is drawn at random from [floor, ceiling) at reset
//  6. When pool ≥ hit_value → jackpot fires → pool resets to floor
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
  private lastCoinIn = new Map<string, number>();

  // In-memory mirror of Redis config (loaded on init, updated by configure())
  private enabled = false;
  private floor   = 10000;   // credits = $100.00
  private ceiling = 30000;   // credits = $300.00
  private rate    = 0.01;    // 1% — decimal form of the UI percentage

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
    // Poll every 2 s — reads machine coin_in from Redis digital twin
    this.ticker = setInterval(() => this.tick().catch(() => {}), 2000);
  }

  onModuleDestroy(): void {
    if (this.ticker) clearInterval(this.ticker);
  }

  // ── Called by controller when operator configures the engine ─

  async configure(
    floor: number,
    ceiling: number,
    rate: number,     // UI sends percentage (e.g. 1.0); stored as decimal
    enabled: boolean,
  ): Promise<void> {
    this.floor   = Math.max(1, Math.floor(floor));
    this.ceiling = Math.max(this.floor + 1, Math.floor(ceiling));
    this.rate    = Math.max(0, rate) / 100;
    this.enabled = enabled;
    this.lastCoinIn.clear(); // reset delta tracking for new round

    await this.redis.set('vjp:floor',   String(this.floor));
    await this.redis.set('vjp:ceiling', String(this.ceiling));
    await this.redis.set('vjp:rate',    String(this.rate));
    await this.redis.set('vjp:enabled', enabled ? 'true' : 'false');

    if (enabled) {
      // Reset pool to floor and generate a new secret hit value
      await this.redis.set('vjp:pool', String(this.floor));
      await this.redis.set('vjp:hit',  String(this.newHitValue()));
      // Immediately broadcast so leaderboard shows starting value
      this.leaderboard.broadcastJackpotPool(this.floor);
    }
  }

  async getPool(): Promise<number> {
    const v = await this.redis.get('vjp:pool');
    return v ? Math.floor(parseFloat(v)) : this.floor;
  }

  // ── Internal helpers ─────────────────────────────────────────

  private async loadConfig(): Promise<void> {
    const en = await this.redis.get('vjp:enabled');
    const f  = await this.redis.get('vjp:floor');
    const c  = await this.redis.get('vjp:ceiling');
    const r  = await this.redis.get('vjp:rate');
    this.enabled = en === 'true';
    if (f) this.floor   = parseInt(f);
    if (c) this.ceiling = parseInt(c);
    if (r) this.rate    = parseFloat(r);
  }

  private async tick(): Promise<void> {
    if (!this.enabled) return;

    const active = await this.tournaments.findOne({
      where: { status: TournamentStatus.ACTIVE },
      order: { id: 'DESC' },
    });
    if (!active) return;

    // Sum coin_in deltas across all machines in the tournament
    let totalDelta = 0;
    for (const machineId of active.machine_ids) {
      const state = await this.redis.getMachineState(machineId);
      if (!state?.coin_in) continue;
      const current = parseInt(state.coin_in);
      const last    = this.lastCoinIn.get(machineId) ?? current;
      const delta   = current - last;
      if (delta > 0) totalDelta += delta;
      this.lastCoinIn.set(machineId, current);
    }

    // Load current pool
    const poolStr = await this.redis.get('vjp:pool');
    let pool = poolStr ? parseFloat(poolStr) : this.floor;

    if (totalDelta > 0) {
      pool += totalDelta * this.rate;

      const hitStr = await this.redis.get('vjp:hit');
      const hit    = hitStr ? parseInt(hitStr) : this.ceiling;

      if (pool >= hit) {
        // Jackpot fires — award to the current tournament leader
        const rankings = await this.redis.getLeaderboard(active.id);
        const winner   = rankings[0]?.machineId ?? 'VIRTUAL';
        const amount   = Math.floor(pool);
        console.log(`🎰 Virtual Jackpot HIT — ${winner}: $${(amount / 100).toFixed(2)}`);
        // Persist hit record
        await this.jackpotHits.save({
          machine_id:    winner,
          amount,
          tournament_id: active.id,
          session_id:    active.session_id ?? null,
        });
        // Broadcast with optional video URL
        const videoUrl = await this.redis.get('vjp:video_url');
        this.leaderboard.broadcastJackpotHit(winner, amount, videoUrl || null);
        // Reset pool and re-arm
        pool = this.floor;
        await this.redis.set('vjp:hit', String(this.newHitValue()));
      }

      await this.redis.set('vjp:pool', String(pool));
    }

    // Always broadcast current pool while tournament is running
    this.leaderboard.broadcastJackpotPool(Math.floor(pool));
  }

  private newHitValue(): number {
    return Math.floor(this.floor + Math.random() * (this.ceiling - this.floor));
  }
}
