// =============================================================
// app.module.ts – Root NestJS Module
// =============================================================
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';

import { DatabaseModule } from './database/database.module';
import { DeviceGatewayModule } from './device-gateway/device-gateway.module';
import { TournamentModule } from './tournament/tournament.module';
import { JackpotModule } from './jackpot/jackpot.module';
import { RedisModule } from './redis/redis.module';
import { MachineEntity } from './database/entities/machine.entity';
import { TransactionEntity } from './database/entities/transaction.entity';
import { TournamentEntity } from './database/entities/tournament.entity';

@Module({
  imports: [
    // Load .env
    ConfigModule.forRoot({ isGlobal: true }),

    // PostgreSQL via TypeORM
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        type: 'postgres',
        host: cfg.get('DB_HOST'),
        port: +cfg.get('DB_PORT'),
        database: cfg.get('DB_NAME'),
        username: cfg.get('DB_USER'),
        password: cfg.get('DB_PASS'),
        entities: [MachineEntity, TransactionEntity, TournamentEntity],
        synchronize: cfg.get('NODE_ENV') !== 'production',
        logging: false,
      }),
    }),

    // Cron jobs
    ScheduleModule.forRoot(),

    // Feature modules
    RedisModule,
    DatabaseModule,
    DeviceGatewayModule,
    TournamentModule,
    JackpotModule,
  ],
})
export class AppModule {}
