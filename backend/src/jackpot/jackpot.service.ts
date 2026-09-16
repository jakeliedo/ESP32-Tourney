// =============================================================
// jackpot.service.ts – Mystery Jackpot Engine (Real JP)
//
// Algorithm (2026-09-09 redesign, mirrors VirtualJackpotService):
//  1. Pool grows from real coin-in (contributionRate % of each wager),
//     computed as a coin-in DELTA per machine every 2s tick (see
//     accrueCoinIn(), called from checkSchedule()) -- reading each
//     tournament machine's live coin_in meter from the Redis digital twin
//     (kept fresh by MqttGatewayService.processTelemetry()). NOTE
//     (2026-09-10): this used to be a separate processCoinIn(machineId,
//     amount) method meant to be called per telemetry event, but nothing
//     ever called it -- the pool never actually grew from real play at
//     all. Folded into this service's own ticker instead so it's
//     self-contained (also avoids a circular dependency, since
//     MqttGatewayService is already a constructor dependency of this
//     service for sending the AFT_PUMP payout).
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

const TICK_INTERVAL_SEC = 2;   // matches the setInterval() below
const RAMP_WINDOW_SEC   = 6;   // start nudging pool toward `min` this many seconds before a scheduled hit

@Injectable()
export class JackpotService implements OnModuleInit, OnModuleDestroy {
  private ticker: ReturnType<typeof setInterval> | null = null;

  private contributionRate: number;
  private initial: number;  // pool value right after a reset (round start / post-hit)
  private min: number;      // minimum payout a hit can ever be clamped up to
  private max: number;      // maximum payout a hit can ever be clamped down to
  private numHits = 1;   // guaranteed jackpot hits per round
  private lastCoinIn = new Map<string, number>();  // machineId -> last-seen cumulative coin_in

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
    this.min     = +this.cfg.get('JACKPOT_BASE_AMOUNT', 10000);
    this.max     = +this.cfg.get('JACKPOT_MAX_AMOUNT', 1000000);
    // No dedicated env var for this yet -- defaults to `min` (old behavior:
    // floor doubled as both reset value and payout floor) unless overridden.
    this.initial = +this.cfg.get('JACKPOT_INITIAL_AMOUNT', this.min);

    // Override with saved config from Redis (persists across restarts)
    const i  = await this.redis.get('jackpot:initial');
    const mn = await this.redis.get('jackpot:min');
    const mx = await this.redis.get('jackpot:max');
    const r  = await this.redis.get('jackpot:contrib_rate');
    const nh = await this.redis.get('jackpot:num_hits');
    if (i)  this.initial          = parseInt(i);
    if (mn) this.min              = parseInt(mn);
    if (mx) this.max              = parseInt(mx);
    if (r)  this.contributionRate = parseFloat(r);
    if (nh) this.numHits          = parseInt(nh);

    // Ensure pool is initialised
    const pool = await this.redis.getJackpotPool();
    if (pool === 0) await this.redis.resetJackpotPool(this.initial);

    this.ticker = setInterval(() => this.checkSchedule().catch(() => {}), TICK_INTERVAL_SEC * 1000);
  }

  onModuleDestroy(): void {
    if (this.ticker) clearInterval(this.ticker);
  }

  // ── Called by controller when operator updates settings ───

  async configure(
    initial: number, min: number, max: number, rate: number, numHits: number,
  ): Promise<void> {
    this.min               = Math.max(1, Math.floor(min));
    this.max                = Math.max(this.min + 1, Math.floor(max));
    // initial is where the pool starts/resets to -- allowed to sit anywhere
    // up to `min` (it's meant to climb INTO [min, max] from real coin-in,
    // not necessarily start already at the payout floor), but never above it
    // or a hit could fire below its own configured floor on the very first
    // tick of a round.
    this.initial            = Math.max(1, Math.min(Math.floor(initial), this.min));
    this.contributionRate  = Math.max(0, rate) / 100;
    this.numHits            = Math.max(1, Math.round(numHits));

    await this.redis.set('jackpot:initial',      String(this.initial));
    await this.redis.set('jackpot:min',          String(this.min));
    await this.redis.set('jackpot:max',          String(this.max));
    await this.redis.set('jackpot:contrib_rate', String(this.contributionRate));
    await this.redis.set('jackpot:num_hits',     String(this.numHits));

    // Reset pool; clear the "armed" marker so checkSchedule() draws a fresh
    // schedule the next time it sees an active tournament (see comment in
    // VirtualJackpotService.configure() for why this can't happen here --
    // we don't yet reliably know the round's real duration_seconds).
    await this.redis.resetJackpotPool(this.initial);
    await this.redis.del('jackpot:armed_tournament_id');
  }

  getConfig(): { initial: number; min: number; max: number; rate: number; numHits: number } {
    return {
      initial: this.initial,
      min:     this.min,
      max:     this.max,
      rate:    this.contributionRate * 100,
      numHits: this.numHits,
    };
  }

  // ── Scheduled firing (2s tick, mirrors VirtualJackpotService.tick()) ──

  private async checkSchedule(): Promise<void> {
    const mode = await this.redis.get('jackpot:mode');
    if (mode === 'virtual') return;

    const active = await this.tournaments.findOne({
      where: { status: TournamentStatus.ACTIVE },
      order: { id: 'DESC' },
    });
    if (!active) {
      // No ACTIVE tournament right now -- if one just ended (or was
      // cancelled) while this service still had unfired guaranteed hits
      // armed for it, fire them now with whatever the pool holds instead of
      // silently dropping the round's numHits commitment (this can happen
      // if the round's real active window closes a tick before a scheduled
      // target's elapsed-time would have crossed).
      await this.forceFireRemaining();
      return;
    }

    const armedId = await this.redis.get('jackpot:armed_tournament_id');
    let targets: number[];
    let hitIdx: number;
    const isNewRound = armedId !== String(active.id);

    if (isNewRound) {
      targets = this.scheduleTargets(active.duration_seconds);
      hitIdx  = 0;
      await this.redis.set('jackpot:armed_tournament_id', String(active.id));
      await this.redis.set('jackpot:targets', JSON.stringify(targets));
      await this.redis.set('jackpot:hit_idx', '0');
      await this.redis.resetJackpotPool(this.initial);
      // Reseed the coin-in baseline to each machine's CURRENT meter value
      // so this round's accrual starts from zero, instead of counting
      // whatever coin-in happened between rounds (or before this service
      // last saw the machine) as a false contribution.
      this.lastCoinIn.clear();
      for (const machineId of active.machine_ids) {
        const state = await this.redis.getMachineState(machineId);
        if (state?.coin_in) this.lastCoinIn.set(machineId, parseInt(state.coin_in));
      }
    } else {
      const targetsStr = await this.redis.get('jackpot:targets');
      targets = targetsStr ? JSON.parse(targetsStr) : [];
      const idxStr = await this.redis.get('jackpot:hit_idx');
      hitIdx = idxStr ? parseInt(idxStr) : 0;
    }

    // Accrue real coin-in since the last tick, across this round's
    // machines -- the Redis digital twin's coin_in is kept fresh by
    // MqttGatewayService.processTelemetry() independently of this service.
    if (!isNewRound) {
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
      if (totalDelta > 0) {
        await this.redis.incrementJackpotPool(totalDelta * this.contributionRate);
      }
    }

    // Nudge the pool toward `min` in the final stretch before a scheduled
    // hit, so a hit landing early in a round (little real coin-in accrued
    // yet) doesn't force-clamp the payout up to `min` from a displayed pool
    // that's visibly nowhere close (found 2026-09-16 -- the trigger is
    // time-based, independent of the pool's real value, so this could
    // report a "$500 jackpot" while the on-screen counter was still sitting
    // at $150). Ramps evenly over the remaining ticks in the window so the
    // existing frontend smoothing renders it as a normal-looking climb, not
    // a teleport.
    const elapsedSec = active.started_at
      ? (Date.now() - new Date(active.started_at).getTime()) / 1000
      : 0;
    if (hitIdx < targets.length && active.started_at) {
      const timeUntilHit = targets[hitIdx] - elapsedSec;
      if (timeUntilHit > 0 && timeUntilHit <= RAMP_WINDOW_SEC) {
        const poolNow  = await this.redis.getJackpotPool();
        const deficit  = this.min - poolNow;
        if (deficit > 0) {
          const ticksRemaining = Math.max(1, Math.ceil(timeUntilHit / TICK_INTERVAL_SEC));
          await this.redis.incrementJackpotPool(deficit / ticksRemaining);
        }
      }
    }

    // Broadcast the live pool every tick, same as VirtualJackpotService --
    // without this, the leaderboard's jackpot panel never updates at all
    // while in 'real' mode (it's driven purely by this socket event, and
    // nothing else in this service ever emitted it).
    const currentPool = await this.redis.getJackpotPool();
    this.leaderboard.broadcastJackpotPool(Math.round(currentPool));

    if (hitIdx >= targets.length || !active.started_at) return;
    if (elapsedSec < targets[hitIdx]) return;

    const pool   = currentPool;
    const amount = Math.round(Math.min(Math.max(pool, this.min), this.max));

    const rankings = await this.redis.getLeaderboard(active.id);
    const winner   = rankings[0]?.machineId ?? 'REAL';

    await this.triggerJackpot(winner, amount, active.id, active.session_id ?? null);
    await this.redis.set('jackpot:hit_idx', String(hitIdx + 1));
  }

  // Safety net for checkSchedule()'s `!active` branch: a round can end
  // NATURALLY (timer runs out -> FINISHED) with fewer than `numHits`
  // scheduled targets actually crossed, e.g. if the real active window
  // closes a tick before the last target's elapsed-time would have. Rather
  // than silently losing the round's numHits guarantee, fire whatever is
  // still pending immediately, clamped into [min, max] just like a normal
  // scheduled hit.
  //
  // Does NOT apply to a manually-STOPped (CANCELLED) round -- cancel() in
  // tournament.service.ts calls resetForCancelledRound() synchronously,
  // which clears `armed_tournament_id` before this ever gets a chance to
  // run, so this correctly no-ops for that case (a cancelled round pays out
  // no results/jackpot, same as it saves no RoundResultEntity -- found
  // 2026-09-16, this safety net was firing a jackpot on manual STOP, which
  // contradicts that "cancel = no consequences" rule).
  private async forceFireRemaining(): Promise<void> {
    const armedId = await this.redis.get('jackpot:armed_tournament_id');
    if (!armedId) return;

    const targetsStr = await this.redis.get('jackpot:targets');
    const targets: number[] = targetsStr ? JSON.parse(targetsStr) : [];
    const idxStr = await this.redis.get('jackpot:hit_idx');
    let hitIdx = idxStr ? parseInt(idxStr) : 0;
    if (hitIdx >= targets.length) return;

    const tournamentId = parseInt(armedId);
    const pool   = await this.redis.getJackpotPool();
    const amount = Math.round(Math.min(Math.max(pool, this.min), this.max));
    const rankings = await this.redis.getLeaderboard(tournamentId);
    const winner   = rankings[0]?.machineId ?? 'REAL';

    while (hitIdx < targets.length) {
      await this.triggerJackpot(winner, amount, tournamentId, null);
      hitIdx += 1;
    }
    // Mark this round fully settled so subsequent ticks (still `!active`,
    // e.g. between rounds) don't re-fire against the same armed id.
    await this.redis.set('jackpot:hit_idx', String(hitIdx));
  }

  // Called synchronously by TournamentService.cancel() right after a manual
  // STOP -- resets pool/schedule immediately instead of leaving it frozen
  // at whatever value it happened to be at (visible on the leaderboard/
  // control-panel odometer for up to the next 2s tick otherwise) and, more
  // importantly, clears `armed_tournament_id` BEFORE the next tick so
  // forceFireRemaining() can't mistake this cancelled round for a naturally-
  // finished one and pay out a jackpot for it.
  async resetForCancelledRound(tournamentId: number): Promise<void> {
    const armedId = await this.redis.get('jackpot:armed_tournament_id');
    if (armedId !== String(tournamentId)) return; // not this round's jackpot state

    await this.redis.resetJackpotPool(this.initial);
    await this.redis.del('jackpot:armed_tournament_id');
    await this.redis.del('jackpot:targets');
    await this.redis.del('jackpot:hit_idx');
    this.leaderboard.broadcastJackpotPool(this.initial);
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

    await this.redis.resetJackpotPool(this.initial);
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
