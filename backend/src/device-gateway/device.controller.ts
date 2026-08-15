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
    const list = await this.machines.find();
    for (const m of list) {
      this.mqtt.sendCommand(m.machine_id, { type: 'AFT_PUMP' as const, amount: body.amount });
      await sleep(200);
    }
    return { ok: true, count: list.length };
  }

  @Post('aft-out-all')
  async aftOutAll() {
    const list = await this.machines.find();
    for (const m of list) {
      this.mqtt.sendCommand(m.machine_id, { type: 'AFT_WITHDRAW' as const, amount: 0 });
      await sleep(200);
    }
    return { ok: true, count: list.length };
  }

  @Post(':id/command')
  sendCommand(
    @Param('id') id: string,
    @Body() body: { type: string; amount?: number },
  ) {
    this.mqtt.sendCommand(id, body as any);
    return { ok: true };
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
