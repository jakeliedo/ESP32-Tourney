// =============================================================
// machine.entity.ts – Slot Machine device record
// =============================================================
import {
  Entity, PrimaryColumn, Column, UpdateDateColumn, CreateDateColumn,
} from 'typeorm';

export enum MachineStatus {
  ONLINE    = 'online',
  OFFLINE   = 'offline',
  PLAYING   = 'playing',
  LOCKED    = 'locked',
  HANDPAY   = 'handpay',
  DISABLED  = 'disabled',
}

@Entity('machines')
export class MachineEntity {
  @PrimaryColumn({ type: 'varchar', length: 50 })
  machine_id: string;   // e.g. "GMI-Machine-01"

  @Column({ type: 'varchar', length: 100, nullable: true, default: '' })
  display_name: string;

  @Column({ type: 'varchar', length: 15, nullable: true })
  ip_address: string;

  @Column({ type: 'enum', enum: MachineStatus, default: MachineStatus.OFFLINE })
  status: MachineStatus;

  @Column({ type: 'int', default: 0 })
  credits: number;

  @Column({ type: 'bigint', default: 0 })
  coin_in: number;

  @Column({ type: 'bigint', default: 0 })
  coin_out: number;

  @Column({ type: 'int', nullable: true })
  tournament_id: number;

  // Machine-diagnostics fields (2026-09-17) -- LP 0xA0/0xA4/0x0E + LP 0x08
  // bookkeeping, refreshed at boot/every ~5min/on-demand (see
  // sas_polling.cpp), NOT on every telemetry tick like bv_enabled/
  // printer_enabled -- persisted so a cold-opened Diagnostics view shows
  // last-known values instead of blank. null = never successfully queried
  // yet, not "confirmed off/zero".
  @Column({ type: 'bigint', nullable: true })
  cash_out_limit_cents: number | null;

  @Column({ type: 'int', nullable: true })
  enabled_features: number | null;

  @Column({ type: 'boolean', nullable: true })
  rte_guard_ok: boolean | null;

  @Column({ type: 'boolean', nullable: true })
  bill_config_ok: boolean | null;

  @Column({ type: 'int', nullable: true })
  last_cycle_overrun_ms: number | null;

  // Machine identity/config (2026-09-17) -- for the single-machine "read
  // everything at once" technical view (frontend/diagnostics). Same
  // boot-time/on-demand refresh cadence and null="never queried yet"
  // semantics as the diagnostics fields above.
  @Column({ type: 'varchar', length: 40, nullable: true })
  serial_number: string | null;

  @Column({ type: 'varchar', length: 3, nullable: true })
  sas_version: string | null;

  @Column({ type: 'int', nullable: true })
  denom_code: number | null;

  @Column({ type: 'bigint', nullable: true })
  denom_value_x10000: number | null;

  @Column({ type: 'bigint', nullable: true })
  asset_number: number | null;

  @Column({ type: 'boolean', nullable: true })
  aft_registered: boolean | null;

  // Bill validator / ticket printer state (2026-09-17) -- previously
  // broadcast-only (WebSocket machine_update), not persisted, since
  // control-panel's live view never needed a DB copy. Persisted now so a
  // plain REST GET /api/machines (no WebSocket client) -- e.g.
  // frontend/diagnostics's single-machine technical view -- can show them
  // too. null = not yet known (mirrors firmware's own boot-time default
  // uncertainty), not "confirmed off".
  @Column({ type: 'boolean', nullable: true })
  bv_enabled: boolean | null;

  @Column({ type: 'boolean', nullable: true })
  printer_enabled: boolean | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
