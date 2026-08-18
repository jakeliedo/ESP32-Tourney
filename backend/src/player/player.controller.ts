// =============================================================
// player.controller.ts – CRUD for player / membership registry
// =============================================================
import {
  Controller, Get, Post, Patch, Delete,
  Param, Body, NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PlayerEntity } from '../database/entities/player.entity';

@Controller('api/players')
export class PlayerController {
  constructor(
    @InjectRepository(PlayerEntity)
    private readonly players: Repository<PlayerEntity>,
  ) {}

  @Get()
  findAll() {
    return this.players.find({ order: { membership_number: 'ASC' } });
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    const p = await this.players.findOneBy({ membership_number: id });
    if (!p) throw new NotFoundException(`Player ${id} not found`);
    return p;
  }

  /** Upsert: creates or updates by membership_number */
  @Post()
  async upsert(@Body() body: { membership_number: string; display_name: string }) {
    await this.players.upsert(
      { membership_number: body.membership_number, display_name: body.display_name },
      ['membership_number'],
    );
    return this.players.findOneBy({ membership_number: body.membership_number });
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: { display_name?: string }) {
    await this.players.update({ membership_number: id }, body);
    return this.players.findOneBy({ membership_number: id });
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.players.delete({ membership_number: id });
    return { ok: true };
  }
}
