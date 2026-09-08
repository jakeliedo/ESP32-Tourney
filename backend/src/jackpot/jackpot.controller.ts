// =============================================================
// jackpot.controller.ts – Jackpot REST API
// =============================================================
import {
  Controller, Get, Post, Body, UseInterceptors, UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import * as fs from 'fs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { JackpotService } from './jackpot.service';
import { VirtualJackpotService } from './virtual-jackpot.service';
import { RedisService } from '../redis/redis.module';
import { JackpotHitEntity } from '../database/entities/jackpot_hit.entity';

interface VirtualJackpotConfigDto {
  floor: number;          // credits (e.g. 10000 = $100.00)
  ceiling: number;        // credits (e.g. 30000 = $300.00)
  tickIncrement: number;  // credits added per 2s tick (constant, no coin-in dependency)
  enabled: boolean;
}

interface RealJackpotConfigDto {
  floor: number;    // credits
  ceiling: number;  // credits
  rate: number;     // percentage (e.g. 0.5 = 0.5%)
}

@Controller('api/jackpot')
export class JackpotController {
  constructor(
    private readonly svc: JackpotService,
    private readonly vjp: VirtualJackpotService,
    private readonly redis: RedisService,
    @InjectRepository(JackpotHitEntity)
    private readonly hits: Repository<JackpotHitEntity>,
  ) {}

  // ── Mode toggle (real | virtual) ─────────────────────────

  @Get('mode')
  async getMode() {
    const mode = await this.redis.get('jackpot:mode');
    return { mode: (mode === 'real' ? 'real' : 'virtual') as 'real' | 'virtual' };
  }

  @Post('mode')
  async setMode(@Body() body: { mode: string }) {
    const mode = body.mode === 'real' ? 'real' : 'virtual';
    await this.redis.set('jackpot:mode', mode);
    return { ok: true, mode };
  }

  // ── Real jackpot config ───────────────────────────────────

  @Get('config')
  getRealConfig() {
    return this.svc.getConfig();
  }

  @Post('config')
  async setRealConfig(@Body() dto: RealJackpotConfigDto) {
    await this.svc.configure(dto.floor, dto.ceiling, dto.rate);
    return { ok: true };
  }

  // ── Real jackpot pool ─────────────────────────────────────

  @Get('pool')
  async getPool() {
    const amount = await this.svc.getPoolAmount();
    return { pool_amount: amount };
  }

  // ── Jackpot hit history ───────────────────────────────────

  @Get('hits')
  async getHits() {
    return this.hits.find({ order: { hit_at: 'DESC' }, take: 100 });
  }

  // ── Virtual jackpot config ────────────────────────────────

  @Get('virtual/config')
  getVirtualConfig() {
    return this.vjp.getConfig();
  }

  @Post('virtual/config')
  async setVirtualConfig(@Body() dto: VirtualJackpotConfigDto) {
    await this.vjp.configure(dto.floor, dto.ceiling, dto.tickIncrement, dto.enabled);
    return { ok: true };
  }

  @Get('virtual/pool')
  async getVirtualPool() {
    const pool = await this.vjp.getPool();
    return { pool };
  }

  // ── Virtual jackpot video ─────────────────────────────────

  @Get('virtual/video-url')
  async getVideoUrl() {
    const url  = await this.redis.get('vjp:video_url');
    const name = await this.redis.get('vjp:video_name');
    return { url: url ?? null, name: name ?? null };
  }

  @Post('virtual/video')
  @UseInterceptors(FileInterceptor('file', {
    storage: diskStorage({
      destination: (_req, _file, cb) => {
        const dir = join(process.cwd(), 'uploads');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (_req, file, cb) => {
        cb(null, `jackpot-video${extname(file.originalname)}`);
      },
    }),
    limits: { fileSize: 200 * 1024 * 1024 },
  }))
  async uploadVideo(@UploadedFile() file: Express.Multer.File) {
    if (!file) return { ok: false, error: 'No file received' };
    const url = `/uploads/${file.filename}`;
    await this.redis.set('vjp:video_url',  url);
    await this.redis.set('vjp:video_name', file.originalname);
    return { ok: true, url, name: file.originalname };
  }

  @Post('virtual/video/clear')
  async clearVideo() {
    await this.redis.set('vjp:video_url',  '');
    await this.redis.set('vjp:video_name', '');
    return { ok: true };
  }
}
