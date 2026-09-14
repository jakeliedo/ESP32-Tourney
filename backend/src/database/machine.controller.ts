import { Controller, Get, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MachineEntity } from './entities/machine.entity';
import { RedisService } from '../redis/redis.module';

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
  // only ever showing what's arrived since the socket connected.
  @Get('logs')
  getLogs(
    @Query('severity') severity: 'all' | 'abnormal' = 'all',
    @Query('limit') limit = '300',
  ) {
    const key = severity === 'abnormal' ? 'logs:abnormal' : 'logs:all';
    return this.redis.getLogs(key, Math.min(parseInt(limit, 10) || 300, 1000));
  }
}
