// =============================================================
// tournament.entity.ts – Tournament record
// =============================================================
import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
} from 'typeorm';

export enum TournamentStatus {
  SCHEDULED  = 'scheduled',
  ACTIVE     = 'active',
  FINISHED   = 'finished',
  CANCELLED  = 'cancelled',
}

@Entity('tournaments')
export class TournamentEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'enum', enum: TournamentStatus, default: TournamentStatus.SCHEDULED })
  status: TournamentStatus;

  @Column({ type: 'simple-array' })
  machine_ids: string[];      // machines participating

  @Column({ type: 'int' })
  initial_credits: number;    // credits pumped to each machine

  @Column({ type: 'int' })
  duration_seconds: number;

  @Column({ type: 'varchar', length: 36, nullable: true })
  session_id: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  session_name: string;

  @Column({ type: 'int', default: 1 })
  round_number: number;

  @Column({ type: 'int', default: 1 })
  total_rounds: number;

  @Column({ type: 'timestamp', nullable: true })
  started_at: Date;

  @Column({ type: 'timestamp', nullable: true })
  ended_at: Date;

  @CreateDateColumn()
  created_at: Date;
}
