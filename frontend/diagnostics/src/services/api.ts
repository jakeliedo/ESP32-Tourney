import axios from 'axios';

const api = axios.create({ baseURL: '/api' });

// Mirrors backend/src/database/entities/machine.entity.ts. null = never
// successfully queried by the firmware yet, not "confirmed off/zero".
// Diagnostics/identity fields refresh at boot/every ~5min/on-demand, not
// every telemetry tick like credits/coin_in (see CLAUDE.md's "Machine
// Diagnostics").
export interface Machine {
  machine_id: string;
  display_name: string;
  status: 'online' | 'offline' | 'playing' | 'locked' | 'handpay' | 'disabled';
  credits: number;
  coin_in: number;
  coin_out: number;
  updated_at: string;

  bv_enabled: boolean | null;
  printer_enabled: boolean | null;
  enabled_features: number | null;
  cash_out_limit_cents: number | null;
  rte_guard_ok: boolean | null;
  bill_config_ok: boolean | null;
  last_cycle_overrun_ms: number | null;

  serial_number: string | null;
  sas_version: string | null;
  denom_code: number | null;
  denom_value_x10000: number | null;
  asset_number: number | null;
  aft_registered: boolean | null;
}

export const getMachines = (): Promise<Machine[]> =>
  api.get<Machine[]>('/machines').then(r => r.data);

export const refreshDiagnostics = (machineId: string): Promise<{ ok: boolean }> =>
  api.post(`/machines/${machineId}/command`, { type: 'REFRESH_DIAGNOSTICS' }).then(r => r.data);
