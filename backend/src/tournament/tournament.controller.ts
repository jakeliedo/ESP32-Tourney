// =============================================================
// tournament.controller.ts – REST API for tournament management
// =============================================================
import { Controller, Get, Post, Param, Body, ParseIntPipe } from '@nestjs/common';
import { TournamentService, CreateTournamentDto } from './tournament.service';

@Controller('api/tournaments')
export class TournamentController {
  constructor(private readonly svc: TournamentService) {}

  @Get()
  findAll() {
    return this.svc.findAll();
  }

  @Get('history')
  getHistory() {
    return this.svc.getHistory();
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.svc.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateTournamentDto) {
    return this.svc.create(dto);
  }

  @Post(':id/start')
  start(@Param('id', ParseIntPipe) id: number) {
    return this.svc.start(id);
  }

  @Post(':id/end')
  end(@Param('id', ParseIntPipe) id: number) {
    return this.svc.end(id);
  }

  @Post(':id/cancel')
  cancel(@Param('id', ParseIntPipe) id: number) {
    return this.svc.cancel(id);
  }

  @Post(':id/next-round')
  nextRound(@Param('id', ParseIntPipe) id: number) {
    return this.svc.nextRound(id);
  }

  @Get(':id/leaderboard')
  leaderboard(@Param('id', ParseIntPipe) id: number) {
    return this.svc.getLeaderboard(id);
  }
}
