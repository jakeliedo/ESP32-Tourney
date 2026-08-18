// =============================================================
// round_result.entity.ts – Final standings snapshot per round
// Saved when a tournament ends; supports history and advancement
// =============================================================
import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index,
} from 'typeorm';

@Entity('round_results')
@Index(['session_id', 'round_number'])
export class RoundResultEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  tournament_id: number;

  @Column({ type: 'varchar', length: 50 })
  machine_id: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  player_display: string;   // snapshot of display_name at time of round

  @Column({ type: 'bigint' })
  final_score: number;

  @Column({ type: 'int' })
  rank: number;

  @Column({ type: 'boolean', default: false })
  advanced: boolean;

  @Column({ type: 'varchar', length: 36, nullable: true })
  session_id: string;

  @Column({ type: 'int', default: 1 })
  round_number: number;

  @Column({ type: 'int', default: 1 })
  total_rounds: number;

  @CreateDateColumn()
  created_at: Date;
}
