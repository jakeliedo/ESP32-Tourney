// =============================================================
// player.entity.ts – Tournament player / membership registry
// =============================================================
import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('players')
export class PlayerEntity {
  @PrimaryColumn({ type: 'varchar', length: 30 })
  membership_number: string;

  @Column({ type: 'varchar', length: 100, default: '' })
  display_name: string;

  @CreateDateColumn()
  created_at: Date;
}
