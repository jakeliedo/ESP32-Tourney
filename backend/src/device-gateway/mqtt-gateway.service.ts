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
}

interface ServerCommand {
  type: 'AFT_PUMP' | 'AFT_WITHDRAW' | 'LOCK' | 'UNLOCK' | 'DISABLE' | 'ENABLE'
      | 'ENABLE_BV' | 'DISABLE_BV' | 'ENABLE_PRINTER' | 'DISABLE_PRINTER';
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

    if (data.exception === 0x11) log('abnormal', 'DOOR_OPEN', 'Slot door OPENED');
    if (data.exception === 0x12) log('info', 'DOOR_CLOSE', 'Slot door closed');

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
