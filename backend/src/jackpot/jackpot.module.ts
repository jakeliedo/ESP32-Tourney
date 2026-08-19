// =============================================================
// jackpot.module.ts
// =============================================================
import { Module } from '@nestjs/common';
import { JackpotService } from './jackpot.service';
import { VirtualJackpotService } from './virtual-jackpot.service';
import { JackpotController } from './jackpot.controller';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { DeviceGatewayModule } from '../device-gateway/device-gateway.module';

@Module({
  imports: [DatabaseModule, RedisModule, DeviceGatewayModule],
  providers: [JackpotService, VirtualJackpotService],
  controllers: [JackpotController],
})
export class JackpotModule {}
