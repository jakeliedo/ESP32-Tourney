import { Controller, Post, Patch, Param, Body } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MqttGatewayService } from './mqtt-gateway.service';
import { MachineEntity } from '../database/entities/machine.entity';

@Controller('api/machines')
export class DeviceController {
  constructor(
    private mqtt: MqttGatewayService,
    @InjectRepository(MachineEntity)
    private machines: Repository<MachineEntity>,
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
    const list = await this.machines.find();

    // Publish MQTT commands concurrently (no sleep)
    list.forEach(m =>
      this.mqtt.sendCommand(m.machine_id, { type: 'AFT_PUMP' as const, amount }),
    );

    // Optimistic DB update — UI reflects the change on the next poll
    // Real telemetry will overwrite when machines confirm
    await this.machines
      .createQueryBuilder()
      .update()
      .set({ credits: () => `credits + ${amount}` })
      .execute();

    return { ok: true, count: list.length };
  }

  @Post('aft-out-all')
  async aftOutAll() {
    const list = await this.machines.find();

    // Publish MQTT commands concurrently
    list.forEach(m =>
      this.mqtt.sendCommand(m.machine_id, { type: 'AFT_WITHDRAW' as const, amount: 0 }),
    );

    // Optimistic DB update — clear all credits immediately
    await this.machines
      .createQueryBuilder()
      .update()
      .set({ credits: 0 })
      .execute();

    return { ok: true, count: list.length };
  }

  @Post(':id/command')
  async sendCommand(
    @Param('id') id: string,
    @Body() body: { type: string; amount?: number },
  ) {
    this.mqtt.sendCommand(id, body as any);

    // Optimistic DB update for credit-affecting commands
    const amount = Math.floor(body.amount ?? 0);
    if (body.type === 'AFT_PUMP' && amount > 0) {
      await this.machines
        .createQueryBuilder()
        .update()
        .set({ credits: () => `credits + ${amount}` })
        .where('machine_id = :id', { id })
        .execute();
    } else if (body.type === 'AFT_WITHDRAW') {
      await this.machines.update({ machine_id: id }, { credits: 0 });
    }

    return { ok: true };
  }
}
