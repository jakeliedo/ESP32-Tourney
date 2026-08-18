// =============================================================
// useWebSocket.ts – Socket.IO hook for leaderboard updates
// =============================================================
import { useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';

// When running inside Electron, preload.js exposes window.__config__
// with the backend URL.  In plain-browser / Vite-dev mode the value is
// undefined and we fall back to a relative path (handled by Vite proxy).
const backendUrl = (window as any).__config__?.backendUrl ?? '';

export function useWebSocket(
  onLeaderboard:   (data: any) => void,
  onJackpotHit:    (data: any) => void,
  onMachineUpdate?: (data: any) => void,
) {
  const socketRef = useRef<Socket | null>(null);

  const connect = useCallback(() => {
    // e.g. 'http://192.168.1.100:3000/leaderboard'  (Electron production)
    //      '/leaderboard'                             (Vite dev / browser)
    const socket = io(`${backendUrl}/leaderboard`, {
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    socket.on('leaderboard_update', onLeaderboard);
    socket.on('jackpot_hit',        onJackpotHit);
    if (onMachineUpdate) socket.on('machine_update', onMachineUpdate);

    socket.on('disconnect', () => {
      console.warn('WebSocket disconnected – reconnecting...');
    });
  }, [onLeaderboard, onJackpotHit, onMachineUpdate]);

  useEffect(() => {
    connect();
    return () => { socketRef.current?.disconnect(); };
  }, [connect]);
}
