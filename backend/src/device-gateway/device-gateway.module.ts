// =============================================================
// device-gateway.module.ts
// =============================================================
import { Module } from '@nestjs/common';
import { MqttGatewayService } from './mqtt-gateway.service';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { LeaderboardGateway } from './leaderboard.gateway';

@Module({
  imports: [DatabaseModule, RedisModule],
  providers: [MqttGatewayService, LeaderboardGateway],
  exports: [MqttGatewayService, LeaderboardGateway],
})
export class DeviceGatewayModule {}
