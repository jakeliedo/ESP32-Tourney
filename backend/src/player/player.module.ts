// =============================================================
// player.module.ts
// =============================================================
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlayerEntity } from '../database/entities/player.entity';
import { PlayerController } from './player.controller';

@Module({
  imports: [TypeOrmModule.forFeature([PlayerEntity])],
  controllers: [PlayerController],
  exports: [TypeOrmModule],
})
export class PlayerModule {}
