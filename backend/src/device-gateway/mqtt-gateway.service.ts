// =============================================================
// mqtt-gateway.service.ts – MQTT Broker connection & routing
// Subscribes to all machine telemetry, publishes commands
// =============================================================
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as mqtt from 'mqtt';

import { RedisService } from '../redis/redis.module';
import { MachineEntity, MachineStatus } from '../database/entities/machine.entity';
import { TransactionEntity, TransactionStatus } from '../database/entities/transaction.entity';
import { TournamentEntity, TournamentStatus } from '../database/entities/tournament.entity';
import { LeaderboardGateway } from './leaderboard.gateway';

interface TelemetryPayload {
  machine_id: string;
  exception: number;
  credits: number;
  coin_in: number;
  coin_out: number;
  state: number;
  aft_status?: number;
  txn_id?: string;
}

interface ServerCommand {
  type: 'AFT_PUMP' | 'AFT_WITHDRAW' | 'LOCK' | 'UNLOCK' | 'DISABLE' | 'ENABLE';
  amount?: number;
  txn_id?: string;
}

@Injectable()
export class MqttGatewayService implements OnModuleInit, OnModuleDestroy {
  private client: mqtt.MqttClient;
  private lastCoinIn   = new Map<string, number>();
  private lastCredits  = new Map<string, number>();

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

    this.client.on('message', (topic, payload) =>
      this.handleMessage(topic, payload),
    );

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

    // 4. Push machine update via WebSocket
    this.leaderboard.broadcastMachineUpdate(machineId, data);

    // 5. Update tournament leaderboard when credits change.
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
    const topic = `casino/machine/${machineId}/commands`;
    this.client.publish(topic, JSON.stringify(cmd), { qos: 1 });
  }

  private stateToStatus(state: number): MachineStatus {
    const map: Record<number, MachineStatus> = {
      0: MachineStatus.OFFLINE,
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
