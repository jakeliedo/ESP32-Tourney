import { Controller, Get } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MachineEntity } from './entities/machine.entity';

@Controller('api/machines')
export class MachineController {
  constructor(
    @InjectRepository(MachineEntity)
    private machines: Repository<MachineEntity>,
  ) {}

  @Get()
  findAll(): Promise<MachineEntity[]> {
    return this.machines.find({ order: { machine_id: 'ASC' } });
  }
}
