import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('jackpot_hits')
export class JackpotHitEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ nullable: true })
  machine_id: string | null;

  @Column({ type: 'bigint' })
  amount: number;

  @Column({ nullable: true })
  tournament_id: number | null;

  @Column({ nullable: true })
  session_id: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  hit_at: Date;
}
