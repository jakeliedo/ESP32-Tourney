// =============================================================
// machine.entity.ts – Slot Machine device record
// =============================================================
import {
  Entity, PrimaryColumn, Column, UpdateDateColumn, CreateDateColumn,
} from 'typeorm';

export enum MachineStatus {
  ONLINE   = 'online',
  OFFLINE  = 'offline',
  PLAYING  = 'playing',
  LOCKED   = 'locked',
  HANDPAY  = 'handpay',
}

@Entity('machines')
export class MachineEntity {
  @PrimaryColumn({ type: 'varchar', length: 50 })
  machine_id: string;   // e.g. "GMI-Machine-01"

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

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
