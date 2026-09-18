// =============================================================
// mqtt-gateway.service.ts – MQTT Broker connection & routing
// Subscribes to all machine telemetry, publishes commands
// =============================================================
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as mqtt from 'mqtt';
import { randomUUID } from 'crypto';

import { RedisService } from '../redis/redis.module';
import { MachineEntity, MachineStatus } from '../database/entities/machine.entity';
import { TransactionEntity, TransactionStatus } from '../database/entities/transaction.entity';
import { TournamentEntity, TournamentStatus } from '../database/entities/tournament.entity';
import { LeaderboardGateway, LogEntry } from './leaderboard.gateway';

// Per-machine log history cap (Logs tab) -- each machine keeps its own last
// N entries, independently for the "all" and "abnormal" backlogs.
export const MAX_LOGS_PER_MACHINE = 12;

// Machine-diagnostics thresholds (2026-09-17). Hardcoded for v1 (not yet a
// settings API) -- see sas_commands.h's SAS_FEATURE_* for the bit layout
// this mirrors (must match the firmware's combined
// features1|features2<<8|features3<<16 encoding exactly).
// SAS_FEATURE_AFT_SUPPORTED = Features2 bit6 (combined bit 8+6=14) --
// the one thing this project's AFT-only cash flow actually depends on.
export const SAS_FEATURE_AFT_SUPPORTED = 1 << 14;
export const REQUIRED_FEATURE_MASK = SAS_FEATURE_AFT_SUPPORTED;
// A machine reporting a cash-out limit below MIN_CASH_OUT_LIMIT_CENTS may
// force a handpay instead of a full AFT payout during a tournament. Venue-
// specific (only the operator knows real tournament payout tiers), so this
// is read from .env (see onModuleInit below), not a hardcoded dollar
// figure -- 0/unset disables the check.

interface TelemetryPayload {
  machine_id: string;
  exception: number;
  credits: number;
  coin_in: number;
  coin_out: number;
  state: number;
  aft_status?: number;
  txn_id?: string;
  bv_enabled?: boolean;
  printer_enabled?: boolean;
  enabled_features?: number;
  cash_out_limit_cents?: number;
  aft_transfer_limit_cents?: number;
  rte_guard_ok?: boolean;
  bill_config_ok?: boolean;
  door_open?: boolean;
  last_cycle_overrun_ms?: number;
  serial_number?: string;
  sas_version?: string;
  denom_code?: number;
  denom_value_x10000?: number;
  asset_number?: number;
  aft_registered?: boolean;
}

interface ServerCommand {
  type: 'AFT_PUMP' | 'AFT_WITHDRAW' | 'LOCK' | 'UNLOCK' | 'DISABLE' | 'ENABLE'
      | 'ENABLE_BV' | 'DISABLE_BV' | 'ENABLE_PRINTER' | 'DISABLE_PRINTER'
      | 'REFRESH_DIAGNOSTICS';
  amount?: number;
  txn_id?: string;
}

@Injectable()
export class MqttGatewayService implements OnModuleInit, OnModuleDestroy {
  private client: mqtt.MqttClient;
  private lastCoinIn   = new Map<string, number>();
  private lastCredits  = new Map<string, number>();
  private lastStatus   = new Map<string, MachineStatus>();
  private lastBv       = new Map<string, boolean>();
  private lastPrinter  = new Map<string, boolean>();
  // Machine-diagnostics transition trackers (2026-09-17) -- same
  // "only log on change, not every telemetry tick" discipline as
  // lastBv/lastPrinter above. last_cycle_overrun_ms needs no such map:
  // firmware already only reports it non-zero once per new overrun (see
  // sas_polling.cpp's report-and-clear comment), so a plain `>0` check in
  // processTelemetry is sufficient there.
  private lastFeaturesOk  = new Map<string, boolean>();
  private lastCashOutOk   = new Map<string, boolean>();
  private lastRteGuardOk  = new Map<string, boolean>();
  private lastBillConfigOk = new Map<string, boolean>();
  // Added 2026-09-18, replaces the old exception===0x11/0x12 check (see
  // the comment at its call site) with a proper transition tracker on the
  // persistent door_open field, same style as lastBv/lastPrinter.
  private lastDoorOpen    = new Map<string, boolean>();
  // Venue-specific floor for LP 0xA4 Cash Out Limit, from .env
  // (MIN_CASH_OUT_LIMIT_CENTS) -- 0 disables the check. Set in onModuleInit.
  private minCashOutLimitCents = 0;
  // Per-machine processing queue: `client.on('message', ...)` below fires
  // handleMessage() without awaiting it, and mqtt.js does not wait for a
  // listener's promise before delivering the next message -- so a status
  // "offline" (broker's LWT for a just-dropped session) and the immediately
  // following "online" (from the same board's reconnect, e.g. during a
  // session-takeover reconnect burst) could run as two *concurrent*
  // handleMessage() calls with no guaranteed DB-write order, leaving the
  // machine stuck OFFLINE in the DB even though it's actually connected
  // (reproduced 2026-09-14: offline's handler does extra awaits after its
  // upsert -- tournament lookup, 2 Redis calls, broadcast -- so its DB
  // write can lose a race against online's single-await handler despite
  // being received first). Chaining each machine's messages onto its own
  // promise forces strictly-ordered processing per machine_id regardless
  // of how much async work either branch does, without slowing down other
  // machines' independent queues.
  private messageQueues = new Map<string, Promise<unknown>>();

  constructor(
    private cfg: ConfigService,
    private redis: RedisService,
    private leaderboard: LeaderboardGateway,
    @InjectRepository(MachineEntity)
    private machines: Repository<MachineEntity>,
    @InjectRepository(TransactionEntity)
    private transactions: Repository<TransactionEntity>,
    @InjectRepository(TournamentEntity)
    private tournaments: Repository<TournamentEntity>,
  ) {}

  onModuleInit() {
    const host = this.cfg.get('MQTT_HOST', 'localhost');
    const port = +this.cfg.get('MQTT_PORT', 1883);
    const user = this.cfg.get('MQTT_USER');
    const pass = this.cfg.get('MQTT_PASS');
    this.minCashOutLimitCents = +this.cfg.get('MIN_CASH_OUT_LIMIT_CENTS', 0);

    this.client = mqtt.connect(`mqtt://${host}:${port}`, {
      username: user,
      password: pass,
      clientId: 'backend-gateway',
      reconnectPeriod: 3000,
    });

    this.client.on('connect', () => {
      console.log('MQTT Gateway connected to broker');
      // Subscribe to all machine telemetry
      this.client.subscribe('casino/machine/+/telemetry');
      this.client.subscribe('casino/machine/+/events');
      this.client.subscribe('casino/machine/+/status');
    });

    this.client.on('message', (topic, payload) => {
      const machineId = topic.split('/')[2];
      const prev = this.messageQueues.get(machineId) ?? Promise.resolve();
      const next = prev
        .catch(() => {}) // one bad message must not wedge this machine's queue
        .then(() => this.handleMessage(topic, payload));
      this.messageQueues.set(machineId, next);
    });

    this.client.on('error', (e) =>
      console.error('MQTT Gateway error:', e.message),
    );
  }

  onModuleDestroy() {
    this.client?.end();
  }

  // ── Incoming message router ───────────────────────────────

  private async handleMessage(topic: string, payload: Buffer) {
    const parts = topic.split('/');
    const machineId = parts[2];
    const channel   = parts[3];

    if (channel === 'telemetry') {
      try {
        const data: TelemetryPayload = JSON.parse(payload.toString());
        await this.processTelemetry(machineId, data);
      } catch {
        console.warn(`Invalid telemetry JSON from ${machineId}`);
      }
    }

    if (channel === 'status') {
      const isOnline = payload.toString() === 'online';
      const newStatus = isOnline ? MachineStatus.ONLINE : MachineStatus.OFFLINE;
      await this.machines.upsert(
        { machine_id: machineId, status: newStatus },
        ['machine_id'],
      );

      // Broadcast status change immediately so frontend doesn't wait for next poll cycle.
      this.leaderboard.broadcastMachineUpdate(machineId, { status: newStatus });

      // When machine goes offline, remove it from the active tournament leaderboard
      // and broadcast the updated (possibly empty) rankings immediately.
      if (!isOnline) {
        const activeTourney = await this.tournaments.findOne({
          where: { status: TournamentStatus.ACTIVE },
          order: { id: 'DESC' },
        });
        if (activeTourney) {
          await this.redis.removeFromLeaderboard(activeTourney.id, machineId);
          const rankings = await this.redis.getLeaderboard(activeTourney.id);
          const rawEnd = activeTourney.started_at
            ? new Date(activeTourney.started_at).getTime() + activeTourney.duration_seconds * 1000
            : null;
          const endsAt = rawEnd && rawEnd > Date.now() ? rawEnd : -1;
          this.leaderboard.broadcastLeaderboard(
            activeTourney.id, rankings,
            activeTourney.round_number, activeTourney.total_rounds, endsAt,
          );
        }
      }
    }
  }

  private async processTelemetry(machineId: string, data: TelemetryPayload) {
    // 1. Update Redis digital twin
    await this.redis.setMachineState(machineId, {
      credits: data.credits,
      coin_in: data.coin_in,
      coin_out: data.coin_out,
      state: data.state,
      updated_at: Date.now(),
    });

    // 2. Update PostgreSQL machine snapshot
    await this.machines.upsert(
      {
        machine_id: machineId,
        credits: data.credits,
        coin_in: data.coin_in,
        coin_out: data.coin_out,
        status: this.stateToStatus(data.state),
        // Persisted alongside the diagnostics fields (2026-09-17) so a
        // plain REST client with no WebSocket connection can still see
        // them -- see machine.entity.ts's comment for why this duplicates
        // what broadcastMachineUpdate() already sends live.
        bv_enabled:      data.bv_enabled      ?? null,
        printer_enabled: data.printer_enabled ?? null,
        // Machine-diagnostics fields (2026-09-17) -- firmware always sends
        // these (0/false until its boot-time query succeeds, not omitted),
        // so writing them every tick is safe and matches how
        // credits/coin_in/coin_out are already written unconditionally.
        enabled_features:      data.enabled_features      ?? null,
        cash_out_limit_cents:  data.cash_out_limit_cents   ?? null,
        aft_transfer_limit_cents: data.aft_transfer_limit_cents ?? null,
        rte_guard_ok:          data.rte_guard_ok           ?? null,
        bill_config_ok:        data.bill_config_ok         ?? null,
        door_open:             data.door_open              ?? null,
        last_cycle_overrun_ms: data.last_cycle_overrun_ms  ?? null,
        // Identity/config fields (2026-09-17) -- firmware omits
        // serial_number/sas_version from the JSON entirely until known
        // (empty-string guard in mqtt_client.cpp), so these are genuinely
        // `undefined` (not just falsy) pre-boot-query; `?? null` covers both.
        serial_number:      data.serial_number      ?? null,
        sas_version:        data.sas_version        ?? null,
        denom_code:         data.denom_code         ?? null,
        denom_value_x10000: data.denom_value_x10000 ?? null,
        asset_number:       data.asset_number       ?? null,
        aft_registered:     data.aft_registered     ?? null,
      },
      ['machine_id'],
    );

    // 3. Update AFT transaction status if txn_id present
    if (data.txn_id) {
      await this.transactions.update(
        { txn_id: data.txn_id },
        {
          status: data.aft_status === 0x00
            ? TransactionStatus.SUCCESS
            : TransactionStatus.FAILED,
          aft_status_code: data.aft_status,
        },
      );
    }

    // 4. Classify this update into a log entry (door open/close, BV/printer
    //    disable ack'd by firmware, full machine disable) and fan it out to
    //    the capped Redis backlog + `machine_log` WebSocket event for the
    //    control panel's Logs tab. Only fires on an actual transition, never
    //    on the first-ever telemetry for a machine (prevStatus/prevBv/
    //    prevPrinter undefined) or a repeat of the same value.
    //
    //    statusChanged guards the BV/printer entries because CMD_DISABLE/
    //    CMD_ENABLE flip bv_enabled in the SAME telemetry message as the
    //    status transition -- that's already covered by MACHINE_DISABLED/
    //    MACHINE_ENABLED below, so logging BV separately there would just
    //    be a duplicate. Standalone CMD_(EN|DIS)ABLE_BV / CMD_*_PRINTER
    //    commands never touch `status`, so they aren't affected by the guard.
    const newStatus = this.stateToStatus(data.state);
    const prevStatus = this.lastStatus.get(machineId);
    const statusChanged = prevStatus !== undefined && prevStatus !== newStatus;
    this.lastStatus.set(machineId, newStatus);

    const entries: LogEntry[] = [];
    const log = (severity: LogEntry['severity'], code: string, message: string) =>
      entries.push({ machineId, ts: Date.now(), severity, code, message });

    // Added 2026-09-18: surface a clear, human-readable INDICATION when an
    // AFT transfer was blocked by a real machine-side hardware/physical-
    // state condition, not a config mistake -- found while investigating a
    // test machine that doesn't report door-open via General Poll exception
    // at all (0x11/0x13/.../0x1D never fire) but DOES correctly reject AFT
    // with status 0x87 while a door is open. Without this, an operator just
    // sees "AFT FAILED" with a bare hex code and no idea why. Table 8.3e
    // (SAS 6.02): 0x87 = "gaming machine unable to perform transfers at this
    // time (door open, tilt, disabled, cashout in progress, etc.)" -- the
    // AFT-layer equivalent of a door-open signal for machines/setups where
    // the General Poll exception path isn't wired. No transition-tracking
    // needed here (unlike the guards below) -- every failed txn_id is its
    // own distinct event, not an ongoing state.
    if (data.txn_id && data.aft_status === 0x87) {
      log('abnormal', 'AFT_BLOCKED_HARDWARE',
        'AFT transfer blocked by machine hardware state (door open / tilt / disabled / cashout in progress)');
    } else if (data.txn_id && data.aft_status === 0x84) {
      log('abnormal', 'AFT_OVER_LIMIT',
        "AFT transfer rejected: amount exceeds the gaming machine's transfer limit (see Diagnostics)");
    }

    // Was keyed off `data.exception === 0x11/0x12` -- broken in practice
    // (found 2026-09-18): `exception` only reflects whatever exc value was
    // passed to the ONE report_event() call that produced this specific
    // telemetry message, and most call sites (Credits/Meters/Total-Coin-In/
    // diagnostics polls) hardcode SAS_EXC_NO_ACTIVITY regardless of real
    // door state -- so this only ever matched the single one-shot telemetry
    // message fired at the exact instant the door opened/closed, easy to
    // never see. `door_open` (added 2026-09-18) is forwarded on EVERY
    // telemetry message from firmware's persistent door-state flag, so a
    // plain transition check here (like lastBv/lastPrinter below) actually
    // catches it.
    if (data.door_open !== undefined) {
      const prevDoorOpen = this.lastDoorOpen.get(machineId);
      if (prevDoorOpen !== undefined && prevDoorOpen !== data.door_open) {
        log(
          data.door_open ? 'abnormal' : 'info',
          data.door_open ? 'DOOR_OPEN' : 'DOOR_CLOSE',
          data.door_open ? 'Slot door OPENED' : 'Slot door closed',
        );
      }
      this.lastDoorOpen.set(machineId, data.door_open);
    }

    if (statusChanged && newStatus === MachineStatus.DISABLED) {
      log('abnormal', 'MACHINE_DISABLED', 'Machine DISABLED');
    } else if (statusChanged && prevStatus === MachineStatus.DISABLED) {
      log('info', 'MACHINE_ENABLED', 'Machine re-enabled');
    }

    if (data.bv_enabled !== undefined) {
      const prevBv = this.lastBv.get(machineId);
      if (prevBv !== undefined && prevBv !== data.bv_enabled && !statusChanged) {
        log(
          data.bv_enabled ? 'info' : 'abnormal',
          data.bv_enabled ? 'BV_ENABLED' : 'BV_DISABLED',
          data.bv_enabled ? 'Bill validator re-enabled' : 'Bill validator DISABLED',
        );
      }
      this.lastBv.set(machineId, data.bv_enabled);
    }

    if (data.printer_enabled !== undefined) {
      const prevPrinter = this.lastPrinter.get(machineId);
      if (prevPrinter !== undefined && prevPrinter !== data.printer_enabled && !statusChanged) {
        log(
          data.printer_enabled ? 'info' : 'abnormal',
          data.printer_enabled ? 'PRINTER_ENABLED' : 'PRINTER_DISABLED',
          data.printer_enabled ? 'Printer re-enabled' : 'Printer DISABLED',
        );
      }
      this.lastPrinter.set(machineId, data.printer_enabled);
    }

    // Machine-diagnostics detectors (2026-09-17) -- same transition-only
    // discipline as BV/printer above, so a machine that's been missing a
    // feature/under the cash-out floor/failing a guard for hours doesn't
    // flood the Logs tab on every telemetry tick.
    if (data.enabled_features !== undefined) {
      const ok = (data.enabled_features & REQUIRED_FEATURE_MASK) === REQUIRED_FEATURE_MASK;
      const prevOk = this.lastFeaturesOk.get(machineId);
      if (prevOk !== undefined && prevOk && !ok) {
        log('abnormal', 'FEATURE_UNSUPPORTED', 'Machine reports missing a required SAS feature (LP 0xA0)');
      }
      this.lastFeaturesOk.set(machineId, ok);
    }

    if (data.cash_out_limit_cents !== undefined && this.minCashOutLimitCents > 0) {
      const ok = data.cash_out_limit_cents >= this.minCashOutLimitCents;
      const prevOk = this.lastCashOutOk.get(machineId);
      if (prevOk !== undefined && prevOk && !ok) {
        log('abnormal', 'CASH_OUT_LIMIT_LOW',
          `Cash out limit ($${(data.cash_out_limit_cents / 100).toFixed(2)}) below configured floor`);
      }
      this.lastCashOutOk.set(machineId, ok);
    }

    if (data.rte_guard_ok !== undefined) {
      const prevOk = this.lastRteGuardOk.get(machineId);
      if (prevOk !== undefined && prevOk && !data.rte_guard_ok) {
        log('abnormal', 'RTE_DISABLE_FAILED', 'Machine did not ACK the Real Time Event reporting OFF guard (LP 0x0E)');
      }
      this.lastRteGuardOk.set(machineId, data.rte_guard_ok);
    }

    if (data.bill_config_ok !== undefined) {
      const prevOk = this.lastBillConfigOk.get(machineId);
      if (prevOk !== undefined && prevOk && !data.bill_config_ok) {
        log('abnormal', 'BILL_CONFIG_WRITE_FAILED', 'Machine did not ACK the bill-acceptor persistent-enable write (LP 0x08)');
      }
      this.lastBillConfigOk.set(machineId, data.bill_config_ok);
    }

    // No transition map needed here -- firmware only reports a non-zero
    // value once per new overrun since its last report (report-and-clear,
    // see sas_polling.cpp), so every non-zero reading is already a
    // distinct, real event.
    if (data.last_cycle_overrun_ms && data.last_cycle_overrun_ms > 0) {
      log('info', 'POLL_CYCLE_OVERRUN',
        `General-poll cycle overran by ${data.last_cycle_overrun_ms}ms (budget 40ms)`);
    }

    // Capped PER MACHINE (not one shared list across all machines) so a
    // chatty machine can never push a quiet machine's older entries out of
    // range before the control panel ever sees them -- each machine keeps
    // exactly its own last MAX_LOGS_PER_MACHINE entries, same per-id keying
    // convention as `machine:{id}:state` (found 2026-09-16, previously
    // `logs:all`/`logs:abnormal` were single lists shared by every machine).
    for (const entry of entries) {
      await this.redis.pushLog(`logs:all:${entry.machineId}`, entry, MAX_LOGS_PER_MACHINE);
      if (entry.severity === 'abnormal') {
        await this.redis.pushLog(`logs:abnormal:${entry.machineId}`, entry, MAX_LOGS_PER_MACHINE);
      }
      this.leaderboard.broadcastMachineLog(entry);
    }

    // 5. Push machine update via WebSocket
    this.leaderboard.broadcastMachineUpdate(machineId, data);

    // 6. Update tournament leaderboard when credits change.
    //    ALL machines are tracked in the sorted set (not just machine_ids) so the
    //    leaderboard always shows every connected machine's current credits.
    const lastCreds = this.lastCredits.get(machineId);
    this.lastCredits.set(machineId, data.credits);

    if (lastCreds !== data.credits) {
      const activeTourney = await this.tournaments.findOne({
        where: { status: TournamentStatus.ACTIVE },
        order: { id: 'DESC' },
      });
      if (activeTourney) {
        await this.redis.updateScore(activeTourney.id, machineId, data.credits);
        const rankings = await this.redis.getLeaderboard(activeTourney.id);
        const rawEnd = activeTourney.started_at
          ? new Date(activeTourney.started_at).getTime() + activeTourney.duration_seconds * 1000
          : null;
        const endsAt = rawEnd && rawEnd > Date.now() ? rawEnd : -1;
        this.leaderboard.broadcastLeaderboard(activeTourney.id, rankings, activeTourney.round_number, activeTourney.total_rounds, endsAt);
      }
    }
  }

  // ── Send command to a specific machine ───────────────────

  sendCommand(machineId: string, cmd: ServerCommand) {
    // AFT transfers (SAS 6.02 Section 8.3) require a transaction ID that
    // differs from the machine's last logged transfer, or the machine
    // rejects the request as a duplicate (status 0x81). Callers of this
    // method (buy-in, aft-in-all, aft-out-all) don't supply one, so
    // generate one here -- the single place every AFT command passes
    // through -- rather than requiring every call site to remember to.
    if ((cmd.type === 'AFT_PUMP' || cmd.type === 'AFT_WITHDRAW') && !cmd.txn_id) {
      cmd = { ...cmd, txn_id: randomUUID().replace(/-/g, '').slice(0, 20) };
    }
    const topic = `casino/machine/${machineId}/commands`;
    this.client.publish(topic, JSON.stringify(cmd), { qos: 1 });
  }

  private stateToStatus(state: number): MachineStatus {
    // state 0 = SLOT_STATE_INIT ("still probing SAS address after boot/
    // reconnect", sas_polling.h). Receiving a telemetry message at all
    // already proves MQTT connectivity, so mapping INIT to OFFLINE here
    // let the very first telemetry burst (sent before SAS finishes
    // syncing) clobber a status='online' write that had just landed a
    // moment earlier -- board stuck looking offline in the DB/control-panel
    // even while it kept working and reading real SAS data (found 2026-09-16).
    const map: Record<number, MachineStatus> = {
      0: MachineStatus.ONLINE,
      1: MachineStatus.ONLINE,
      2: MachineStatus.PLAYING,
      3: MachineStatus.LOCKED,
      4: MachineStatus.HANDPAY,
      5: MachineStatus.OFFLINE,
      6: MachineStatus.DISABLED,
    };
    return map[state] ?? MachineStatus.ONLINE;
  }
}
