// =============================================================
// jackpot.controller.ts – Mystery Jackpot REST API
// =============================================================
import { Controller, Get } from '@nestjs/common';
import { JackpotService } from './jackpot.service';

@Controller('api/jackpot')
export class JackpotController {
  constructor(private readonly svc: JackpotService) {}

  @Get('pool')
  async getPool() {
    const amount = await this.svc.getPoolAmount();
    return { pool_amount: amount };
  }
}
