// =============================================================
// database.module.ts
// =============================================================
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MachineEntity } from './entities/machine.entity';
import { TransactionEntity } from './entities/transaction.entity';
import { TournamentEntity } from './entities/tournament.entity';
import { PlayerEntity } from './entities/player.entity';
import { RoundResultEntity } from './entities/round_result.entity';
import { JackpotHitEntity } from './entities/jackpot_hit.entity';
import { MachineController } from './machine.controller';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([MachineEntity, TransactionEntity, TournamentEntity, PlayerEntity, RoundResultEntity, JackpotHitEntity]),
    RedisModule,
  ],
  controllers: [MachineController],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
