// =============================================================
// database.module.ts
// =============================================================
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MachineEntity } from './entities/machine.entity';
import { TransactionEntity } from './entities/transaction.entity';
import { TournamentEntity } from './entities/tournament.entity';

@Module({
  imports: [TypeOrmModule.forFeature([MachineEntity, TransactionEntity, TournamentEntity])],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
