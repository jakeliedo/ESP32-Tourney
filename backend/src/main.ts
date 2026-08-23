// =============================================================
// main.ts – NestJS Application Entry Point
// =============================================================
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { join } from 'path';
import * as fs from 'fs';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // CORS — allow dev frontends and Electron (file:// sends null Origin)
  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      const allowed = ['http://localhost:5173', 'http://localhost:5174'];
      if (!origin || origin === 'null' || allowed.includes(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    credentials: true,
  });

  // Serve uploaded files (jackpot video, etc.)
  // A CORS header is added explicitly because express static middleware
  // bypasses the NestJS CORS pipeline — Electron renderers need this.
  const uploadsDir = join(process.cwd(), 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  app.use('/uploads', (_req: any, res: any, next: any) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
  });
  app.useStaticAssets(uploadsDir, { prefix: '/uploads' });

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`ESP32 Tourney Backend running on port ${port}`);
}

bootstrap();
