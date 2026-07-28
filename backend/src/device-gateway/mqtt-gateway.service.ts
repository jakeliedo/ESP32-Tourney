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
  type: 'AFT_PUMP' | 'AFT_WITHDRAW' | 'LOCK' | 'UNLOCK';
  amount?: number;
  txn_id?: string;
}

@Injectable()
export class MqttGatewayService implements OnModuleInit, OnModuleDestroy {
  private client: mqtt.MqttClient;

  constructor(
    private cfg: ConfigService,
    private redis: RedisService,
    private leaderboard: LeaderboardGateway,
    @InjectRepository(MachineEntity)
    private machines: Repository<MachineEntity>,
    @InjectRepository(TransactionEntity)
    private transactions: Repository<TransactionEntity>,
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
      await this.machines.upsert(
        { machine_id: machineId, status: isOnline ? MachineStatus.ONLINE : MachineStatus.OFFLINE },
        ['machine_id'],
      );
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

    // 4. Push leaderboard update via WebSocket
    this.leaderboard.broadcastMachineUpdate(machineId, data);
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
    };
    return map[state] ?? MachineStatus.ONLINE;
  }
}
