// =============================================================
// leaderboard.gateway.ts – WebSocket gateway for real-time GUI
// Broadcasts score updates to all connected Leaderboard clients
// =============================================================
import {
  WebSocketGateway, WebSocketServer, OnGatewayConnection,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/leaderboard',
})
export class LeaderboardGateway implements OnGatewayConnection {
  @WebSocketServer()
  server: Server;

  handleConnection(client: Socket) {
    console.log(`Leaderboard client connected: ${client.id}`);
  }

  broadcastMachineUpdate(machineId: string, data: object) {
    this.server.emit('machine_update', { machineId, ...data });
  }

  broadcastLeaderboard(tournamentId: number, rankings: object[]) {
    this.server.emit('leaderboard_update', { tournamentId, rankings });
  }

  broadcastJackpotHit(machineId: string, amount: number) {
    this.server.emit('jackpot_hit', { machineId, amount, timestamp: Date.now() });
  }
}
