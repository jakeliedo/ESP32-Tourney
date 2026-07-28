// =============================================================
// redis.module.ts + redis.service.ts – Redis in-memory cache
// Stores machine digital twin (state, credits, rankings)
// =============================================================
import { Module, Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit {
  private client: Redis;

  constructor(private cfg: ConfigService) {}

  onModuleInit() {
    this.client = new Redis({
      host: this.cfg.get('REDIS_HOST', 'localhost'),
      port: +this.cfg.get('REDIS_PORT', 6379),
    });
    this.client.on('connect', () => console.log('Redis connected'));
    this.client.on('error', (e) => console.error('Redis error:', e.message));
  }

  // ── Machine state (digital twin) ────────────────────────────
  async setMachineState(machineId: string, state: object): Promise<void> {
    await this.client.hset(`machine:${machineId}`, state as any);
  }

  async getMachineState(machineId: string): Promise<Record<string, string>> {
    return this.client.hgetall(`machine:${machineId}`);
  }

  // ── Tournament leaderboard (sorted set) ────────────────────
  async updateScore(tournamentId: number, machineId: string, score: number): Promise<void> {
    await this.client.zadd(`tourney:${tournamentId}:scores`, score, machineId);
  }

  async getLeaderboard(tournamentId: number, top = 20): Promise<{machineId: string; score: number}[]> {
    const results = await this.client.zrevrangebyscore(
      `tourney:${tournamentId}:scores`, '+inf', '-inf',
      'WITHSCORES', 'LIMIT', 0, top,
    );
    const out: {machineId: string; score: number}[] = [];
    for (let i = 0; i < results.length; i += 2) {
      out.push({ machineId: results[i], score: parseFloat(results[i + 1]) });
    }
    return out;
  }

  // ── Jackpot pool ────────────────────────────────────────────
  async incrementJackpotPool(amount: number): Promise<number> {
    return this.client.incrbyfloat('jackpot:pool', amount);
  }

  async getJackpotPool(): Promise<number> {
    const v = await this.client.get('jackpot:pool');
    return v ? parseFloat(v) : 0;
  }

  async resetJackpotPool(base: number): Promise<void> {
    await this.client.set('jackpot:pool', base);
  }

  async setJackpotHitValue(value: number): Promise<void> {
    await this.client.set('jackpot:hit_value', value);
  }

  async getJackpotHitValue(): Promise<number> {
    const v = await this.client.get('jackpot:hit_value');
    return v ? parseFloat(v) : 0;
  }

  // ── Generic helpers ─────────────────────────────────────────
  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.client.setex(key, ttlSeconds, value);
    } else {
      await this.client.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }
}

@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
