import { Controller, Post, Patch, Param, Body } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, In } from 'typeorm';
import { MqttGatewayService } from './mqtt-gateway.service';
import { MachineEntity, MachineStatus } from '../database/entities/machine.entity';
import { TournamentEntity, TournamentStatus } from '../database/entities/tournament.entity';
import { RedisService } from '../redis/redis.module';
import { LeaderboardGateway } from './leaderboard.gateway';

@Controller('api/machines')
export class DeviceController {
  constructor(
    private mqtt: MqttGatewayService,
    private redis: RedisService,
    private leaderboard: LeaderboardGateway,
    @InjectRepository(MachineEntity)
    private machines: Repository<MachineEntity>,
    @InjectRepository(TournamentEntity)
    private tournaments: Repository<TournamentEntity>,
  ) {}

  @Patch(':id')
  async updateMachine(
    @Param('id') id: string,
    @Body() body: { display_name?: string },
  ) {
    await this.machines.update({ machine_id: id }, body);
    return { ok: true };
  }

  @Post('aft-in-all')
  async aftInAll(@Body() body: { amount: number }) {
    // Math.round, not Math.floor: amount is already meant to be a whole
    // number of cents by the time it reaches here, but Math.floor would
    // silently drop a real cent if a caller's own float math ever landed
    // 1 ULP below the intended integer (e.g. 1999.9999999997) -- rounding
    // to nearest preserves the actual cent value instead of discarding it.
    const amount = Math.round(body.amount ?? 0);
    // Only send to non-offline machines; avoids queuing stale AFT commands
    // in Mosquitto that fire when an offline machine reconnects later.
    const list = await this.machines.find({ where: { status: Not(MachineStatus.OFFLINE) } });

    list.forEach(m =>
      this.mqtt.sendCommand(m.machine_id, { type: 'AFT_PUMP' as const, amount }),
    );

    if (list.length) {
      const ids = list.map(m => m.machine_id);
      await this.machines
        .createQueryBuilder()
        .update()
        .set({ credits: () => `credits + ${amount}` })
        .where('machine_id IN (:...ids)', { ids })
        .execute();
    }

    await this.pushLeaderboard({ creditDelta: amount });

    return { ok: true, count: list.length };
  }

  @Post('aft-out-all')
  async aftOutAll() {
    // Excludes DISABLED machines too, not just OFFLINE: a disabled machine
    // must not accept AFT withdrawals (see sas_polling.cpp's CMD_AFT_WITHDRAW
    // handler for the authoritative firmware-side check).
    const list = await this.machines.find({
      where: { status: Not(In([MachineStatus.OFFLINE, MachineStatus.DISABLED])) },
    });

    list.forEach(m =>
      this.mqtt.sendCommand(m.machine_id, { type: 'AFT_WITHDRAW' as const, amount: 0 }),
    );

    if (list.length) {
      const ids = list.map(m => m.machine_id);
      await this.machines
        .createQueryBuilder()
        .update()
        .set({ credits: 0 })
        .where('machine_id IN (:...ids)', { ids })
        .execute();

      // Only reset the leaderboard scores of machines actually withdrawn
      // from -- a disabled machine excluded above keeps its real credits,
      // so its leaderboard score must not be zeroed along with the rest.
      await this.pushLeaderboard({ resetToZero: true, resetIds: ids });
    }

    return { ok: true, count: list.length };
  }

  @Post(':id/command')
  async sendCommand(
    @Param('id') id: string,
    @Body() body: { type: string; amount?: number },
  ) {
    // A disabled machine must not accept AFT withdrawals. This is a UX-level
    // early-out (avoids a pointless MQTT round trip and gives the frontend
    // an immediate error) -- the firmware itself is the authoritative check
    // (see sas_polling.cpp's CMD_AFT_WITHDRAW handler), since this DB copy
    // of "disabled" can be up to one telemetry cycle stale.
    if (body.type === 'AFT_WITHDRAW') {
      const m = await this.machines.findOneBy({ machine_id: id });
      if (m?.status === MachineStatus.DISABLED) {
        return { ok: false, error: 'machine is disabled' };
      }
    }

    this.mqtt.sendCommand(id, body as any);

    // See aftInAll() above for why Math.round, not Math.floor.
    const amount = Math.round(body.amount ?? 0);
    if (body.type === 'AFT_PUMP' && amount > 0) {
      await this.machines
        .createQueryBuilder()
        .update()
        .set({ credits: () => `credits + ${amount}` })
        .where('machine_id = :id', { id })
        .execute();
      const m = await this.machines.findOneBy({ machine_id: id });
      if (m) await this.pushLeaderboard({ machineId: id, newCredits: m.credits });
    } else if (body.type === 'AFT_WITHDRAW') {
      await this.machines.update({ machine_id: id }, { credits: 0 });
      await this.pushLeaderboard({ machineId: id, newCredits: 0 });
    } else if (body.type === 'DISABLE') {
      await this.machines.update({ machine_id: id }, { status: MachineStatus.DISABLED });
    } else if (body.type === 'ENABLE') {
      await this.machines.update({ machine_id: id }, { status: MachineStatus.ONLINE });
    }

    return { ok: true };
  }

  // ── Internal helpers ─────────────────────────────────────────

  private async findActiveTourney(): Promise<TournamentEntity | null> {
    return this.tournaments.findOne({
      where: { status: TournamentStatus.ACTIVE },
      order: { id: 'DESC' },
    });
  }

  private async emitLeaderboard(tourney: TournamentEntity): Promise<void> {
    const rankings = await this.redis.getLeaderboard(tourney.id);
    const rawEnd = tourney.started_at
      ? new Date(tourney.started_at).getTime() + tourney.duration_seconds * 1000
      : null;
    const endsAt = rawEnd && rawEnd > Date.now() ? rawEnd : -1;
    this.leaderboard.broadcastLeaderboard(
      tourney.id, rankings,
      tourney.round_number, tourney.total_rounds,
      endsAt,
    );
  }

  /**
   * Push an immediate leaderboard update after a credit-affecting command.
   *
   * Options (mutually exclusive priority):
   *   machineId + newCredits  — single machine absolute update
   *   creditDelta             — add delta to all tournament machine scores
   *   resetToZero             — zero all tournament machine scores
   */
  private async pushLeaderboard(opts: {
    machineId?: string;
    newCredits?: number;
    creditDelta?: number;
    resetToZero?: boolean;
    resetIds?: string[]; // restricts resetToZero to these machine ids only (default: all tourney machines)
  }): Promise<void> {
    const tourney = await this.findActiveTourney();
    if (!tourney || tourney.machine_ids.length === 0) return;

    if (opts.machineId !== undefined) {
      if (!tourney.machine_ids.includes(opts.machineId)) return;
      await this.redis.updateScore(tourney.id, opts.machineId, opts.newCredits ?? 0);
    } else if (opts.resetToZero) {
      const targets = opts.resetIds ?? tourney.machine_ids;
      for (const mid of targets) {
        if (!tourney.machine_ids.includes(mid)) continue;
        await this.redis.updateScore(tourney.id, mid, 0);
      }
    } else if (opts.creditDelta !== undefined) {
      for (const mid of tourney.machine_ids) {
        await this.redis.incrementScore(tourney.id, mid, opts.creditDelta);
      }
    }

    await this.emitLeaderboard(tourney);
  }
}
