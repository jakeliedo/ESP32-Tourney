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

export default api;
