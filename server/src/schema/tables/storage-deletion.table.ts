import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  type Generated,
  Index,
  Int8,
  PrimaryGeneratedColumn,
  Table,
  type Timestamp,
} from '@immich/sql-tools';
import { StorageBackendTable } from 'src/schema/tables/storage-backend.table.js';

/**
 * Files on storage backends that are no longer recorded and wait for their deletion. Each one gets the earliest time
 * it may be deleted when it is registered, so a shorter delay configured later does not delete it any earlier. Before
 * deleting, the cleanup checks that no location records the file, so a wrong registration never deletes a file in use.
 *
 * Originals keep what is needed to recover them as a new photo until they are deleted.
 */
@Table('storage_deletion')
// a file is registered once, however often its deletion is requested
@Index({ name: 'storage_deletion_backendId_key_idx', columns: ['backendId', 'key'], unique: true })
@Index({ name: 'storage_deletion_notBefore_idx', columns: ['notBefore'] })
export class StorageDeletionTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => StorageBackendTable, { onDelete: 'RESTRICT', onUpdate: 'CASCADE', index: false })
  backendId!: string;

  @Column()
  key!: string;

  /** The earliest time the file may be deleted, from the delay when it was registered */
  @Column({ type: 'timestamp with time zone' })
  notBefore!: Timestamp;

  /** Originals are kept for the configured delay, which applies to registered originals too when it grows */
  @Column({ type: 'boolean' })
  isOriginal!: boolean;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @Column({ type: 'integer', default: 0 })
  attempts!: Generated<number>;

  @Column({ nullable: true })
  lastError!: string | null;

  // recovering an original as a new photo

  @Column({ type: 'uuid', nullable: true })
  ownerId!: string | null;

  @Column({ nullable: true })
  originalFileName!: string | null;

  /** The logical path of the original, whose extension tells its type */
  @Column({ nullable: true })
  originalPath!: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  fileCreatedAt!: Timestamp | null;

  @Column({ type: 'bigint', nullable: true })
  size!: Int8 | null;

  @Column({ type: 'bytea', nullable: true })
  checksum!: Buffer | null;

  @Column({ type: 'bytea', nullable: true })
  encryption!: Buffer | null;
}
