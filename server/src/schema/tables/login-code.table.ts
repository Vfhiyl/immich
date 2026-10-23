import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  type Generated,
  PrimaryGeneratedColumn,
  Table,
  type Timestamp,
} from '@immich/sql-tools';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * One-time codes an administrator shows as a QR code, which the mobile app exchanges for a session of a user: only
 * their SHA-256 is kept, they expire after a few minutes, and are deleted once used
 */
@Table({ name: 'login_code' })
export class LoginCodeTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @Column({ type: 'bytea', unique: true })
  code!: Buffer;

  @ForeignKeyColumn(() => UserTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE' })
  userId!: string;

  /** The administrator who showed the code */
  @ForeignKeyColumn(() => UserTable, { onUpdate: 'CASCADE', onDelete: 'SET NULL', nullable: true })
  createdById!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @Column({ type: 'timestamp with time zone', index: true })
  expiresAt!: Timestamp;
}
