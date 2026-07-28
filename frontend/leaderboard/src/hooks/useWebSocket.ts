// =============================================================
// useWebSocket.ts – Socket.IO hook for leaderboard updates
// =============================================================
import { useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';

export function useWebSocket(
  onLeaderboard: (data: any) => void,
  onJackpotHit:  (data: any) => void,
) {
  const socketRef = useRef<Socket | null>(null);

  const connect = useCallback(() => {
    const socket = io('/leaderboard', { transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('leaderboard_update', onLeaderboard);
    socket.on('jackpot_hit', onJackpotHit);
    socket.on('disconnect', () => {
      console.warn('WebSocket disconnected – reconnecting...');
    });
  }, [onLeaderboard, onJackpotHit]);

  useEffect(() => {
    connect();
    return () => { socketRef.current?.disconnect(); };
  }, [connect]);
}
