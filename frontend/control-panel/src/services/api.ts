import axios from 'axios';

const api = axios.create({ baseURL: '/api' });

export interface Machine {
  machine_id: string;
  display_name: string;
  ip_address: string;
  status: 'online' | 'offline' | 'playing' | 'locked' | 'handpay' | 'disabled';
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
  session_id?: string;
  session_name?: string;
  round_number?: number;
  total_rounds?: number;
  started_at?: string;
  ended_at?: string;
}

export interface Player {
  membership_number: string;
  display_name: string;
}

export interface RoundResultDto {
  rank: number;
  machineId: string;
  playerDisplay: string;
  finalScore: number;
}

export interface RoundDto {
  tournamentId: number;
  roundNumber: number;
  totalRounds: number;
  durationSeconds: number;
  machineCount: number;
  endedAt: string;
  results: RoundResultDto[];
}

export interface SessionDto {
  sessionId: string;
  date: string;
  sessionName: string;
  rounds: RoundDto[];
}

// Machines
export const getMachines = (): Promise<Machine[]> =>
  api.get<Machine[]>('/machines').then(r => r.data);

export const sendMachineCommand = (
  id: string,
  command: { type: string; amount?: number },
): Promise<{ ok: boolean }> =>
  api.post(`/machines/${id}/command`, command).then(r => r.data);

export const aftInAll = (amount: number): Promise<{ ok: boolean; count: number }> =>
  api.post('/machines/aft-in-all', { amount }).then(r => r.data);

export const aftOutAll = (): Promise<{ ok: boolean; count: number }> =>
  api.post('/machines/aft-out-all').then(r => r.data);

// Tournaments
export const getTournaments = (): Promise<Tournament[]> =>
  api.get<Tournament[]>('/tournaments').then(r => r.data);

export const createTournament = (data: Partial<Tournament>): Promise<Tournament> =>
  api.post<Tournament>('/tournaments', data).then(r => r.data);

export const startTournament = (id: number): Promise<void> =>
  api.post(`/tournaments/${id}/start`).then(() => undefined);

export const endTournament = (id: number): Promise<void> =>
  api.post(`/tournaments/${id}/end`).then(() => undefined);

export const cancelTournament = (id: number): Promise<void> =>
  api.post(`/tournaments/${id}/cancel`).then(() => undefined);

export const nextRound = (id: number): Promise<Tournament> =>
  api.post<Tournament>(`/tournaments/${id}/next-round`).then(r => r.data);

export const getHistory = (): Promise<SessionDto[]> =>
  api.get<SessionDto[]>('/tournaments/history').then(r => r.data);

// Players
export const getPlayers = (): Promise<Player[]> =>
  api.get<Player[]>('/players').then(r => r.data);

export const upsertPlayer = (data: Player): Promise<Player> =>
  api.post<Player>('/players', data).then(r => r.data);

export const deletePlayer = (membershipNumber: string): Promise<void> =>
  api.delete(`/players/${encodeURIComponent(membershipNumber)}`).then(() => undefined);

// Virtual Jackpot
export interface VirtualJackpotConfig {
  floor: number;    // credits (e.g. 10000 = $100.00)
  ceiling: number;  // credits (e.g. 30000 = $300.00)
  rate: number;     // percentage (e.g. 1.0 = 1%)
  enabled: boolean;
}

export const setVirtualJackpotConfig = (config: VirtualJackpotConfig): Promise<void> =>
  api.post('/jackpot/virtual/config', config).then(() => undefined);

export const getVirtualJackpotPool = (): Promise<{ pool: number }> =>
  api.get<{ pool: number }>('/jackpot/virtual/pool').then(r => r.data);

export default api;
