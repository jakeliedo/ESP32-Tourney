import { Controller, Get, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MachineEntity } from './entities/machine.entity';
import { RedisService } from '../redis/redis.module';
import { MAX_LOGS_PER_MACHINE } from '../device-gateway/mqtt-gateway.service';

@Controller('api/machines')
export class MachineController {
  constructor(
    @InjectRepository(MachineEntity)
    private machines: Repository<MachineEntity>,
    private redis: RedisService,
  ) {}

  @Get()
  findAll(): Promise<MachineEntity[]> {
    return this.machines.find({ order: { machine_id: 'ASC' } });
  }

  // Backlog for the Logs tab -- lets it survive a page refresh instead of
  // only ever showing what's arrived since the socket connected. Each
  // machine's log is stored (and capped at MAX_LOGS_PER_MACHINE) under its
  // own Redis key -- see mqtt-gateway.service.ts -- so fetch each machine's
  // own backlog and merge, rather than one shared list where a chatty
  // machine could evict a quiet machine's entries first.
  @Get('logs')
  async getLogs(@Query('severity') severity: 'all' | 'abnormal' = 'all') {
    const machines = await this.machines.find();
    const perMachine = await Promise.all(
      machines.map(m => {
        const key = `logs:${severity === 'abnormal' ? 'abnormal' : 'all'}:${m.machine_id}`;
        return this.redis.getLogs(key, MAX_LOGS_PER_MACHINE);
      }),
    );
    return perMachine.flat().sort((a, b) => a.ts - b.ts);
  }
}
