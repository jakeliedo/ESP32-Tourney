import { Controller, Post, Patch, Param, Body } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not } from 'typeorm';
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
    const amount = Math.floor(body.amount ?? 0);
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
    const list = await this.machines.find({ where: { status: Not(MachineStatus.OFFLINE) } });

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
    }

    await this.pushLeaderboard({ resetToZero: true });

    return { ok: true, count: list.length };
  }

  @Post(':id/command')
  async sendCommand(
    @Param('id') id: string,
    @Body() body: { type: string; amount?: number },
  ) {
    this.mqtt.sendCommand(id, body as any);

    const amount = Math.floor(body.amount ?? 0);
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
  }): Promise<void> {
    const tourney = await this.findActiveTourney();
    if (!tourney || tourney.machine_ids.length === 0) return;

    if (opts.machineId !== undefined) {
      if (!tourney.machine_ids.includes(opts.machineId)) return;
      await this.redis.updateScore(tourney.id, opts.machineId, opts.newCredits ?? 0);
    } else if (opts.resetToZero) {
      for (const mid of tourney.machine_ids) {
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
