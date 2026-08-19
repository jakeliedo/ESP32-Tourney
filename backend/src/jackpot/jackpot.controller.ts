// =============================================================
// jackpot.controller.ts – Jackpot REST API
// =============================================================
import { Controller, Get, Post, Body } from '@nestjs/common';
import { JackpotService } from './jackpot.service';
import { VirtualJackpotService } from './virtual-jackpot.service';

interface VirtualJackpotConfigDto {
  floor: number;    // credits (e.g. 10000 = $100.00)
  ceiling: number;  // credits (e.g. 30000 = $300.00)
  rate: number;     // percentage (e.g. 1.0 = 1 %)
  enabled: boolean;
}

@Controller('api/jackpot')
export class JackpotController {
  constructor(
    private readonly svc: JackpotService,
    private readonly vjp: VirtualJackpotService,
  ) {}

  // ── Real jackpot ──────────────────────────────────────────
  @Get('pool')
  async getPool() {
    const amount = await this.svc.getPoolAmount();
    return { pool_amount: amount };
  }

  // ── Virtual jackpot ───────────────────────────────────────
  @Post('virtual/config')
  async setVirtualConfig(@Body() dto: VirtualJackpotConfigDto) {
    await this.vjp.configure(dto.floor, dto.ceiling, dto.rate, dto.enabled);
    return { ok: true };
  }

  @Get('virtual/pool')
  async getVirtualPool() {
    const pool = await this.vjp.getPool();
    return { pool };
  }
}
