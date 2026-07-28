// =============================================================
// api.ts – Axios API client for backend REST endpoints
// =============================================================
import axios from 'axios';

const api = axios.create({ baseURL: '/api' });

export interface Machine {
  machine_id: string;
  ip_address: string;
  status: 'online' | 'offline' | 'playing' | 'locked' | 'handpay';
  credits: number;
  coin_in: number;
  coin_out: number;
  updated_at: string;
}

export interface Tournament {
  id: number;
  name: string;
  status: 'scheduled' | 'active' | 'finished';
  machine_ids: string[];
  initial_credits: number;
  duration_seconds: number;
  started_at?: string;
  ended_at?: string;
}

export interface LeaderboardEntry {
  machineId: string;
  score: number;
}

// Machines
export const getMachines = ()                     => api.get<Machine[]>('/machines');

// Tournaments
export const getTournaments = ()                  => api.get<Tournament[]>('/tournaments');
export const getTournament  = (id: number)        => api.get<Tournament>(`/tournaments/${id}`);
export const createTournament = (data: Partial<Tournament>) => api.post<Tournament>('/tournaments', data);
export const startTournament  = (id: number)      => api.post(`/tournaments/${id}/start`);
export const endTournament    = (id: number)      => api.post(`/tournaments/${id}/end`);
export const getLeaderboard   = (id: number)      => api.get<LeaderboardEntry[]>(`/tournaments/${id}/leaderboard`);

// Jackpot
export const getJackpotPool = () => api.get<{ pool_amount: number }>('/jackpot/pool');

export default api;
