// =============================================================
// tournament.module.ts
// =============================================================
import { Module } from '@nestjs/common';
import { TournamentService } from './tournament.service';
import { TournamentController } from './tournament.controller';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { DeviceGatewayModule } from '../device-gateway/device-gateway.module';

@Module({
  imports: [DatabaseModule, RedisModule, DeviceGatewayModule],
  providers: [TournamentService],
  controllers: [TournamentController],
  exports: [TournamentService],
})
export class TournamentModule {}
