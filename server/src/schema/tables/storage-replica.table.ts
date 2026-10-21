import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  type Generated,
  Index,
  type Int8,
  PrimaryGeneratedColumn,
  Table,
  type Timestamp,
} from '@immich/sql-tools';
import { StorageBackendTable } from 'src/schema/tables/storage-backend.table.js';

/**
 * Which backends each replica copies, as configured. A trigger on the table of original files registers a copy of
 * every new original for each replica of its backend, in the same transaction that records it, so that none is missed.
 */
@Table('storage_replica_source')
export class StorageReplicaSourceTable {
  @ForeignKeyColumn(() => StorageBackendTable, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    primary: true,
    index: false,
  })
  replicaBackendId!: string;

  @ForeignKeyColumn(() => StorageBackendTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true })
  sourceBackendId!: string;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}

/**
 * A copy of a file on a replica: waiting to be made while `completedAt` is null, then a location of the file. The copy
 * has the key of the file below a folder named after its backend, so that a replica can take the place of the backend
 * it copies by pointing the backend there. A copy is only recorded as made once the replica returned its size.
 */
@Table('storage_replica_copy')
@Index({
  name: 'storage_replica_copy_source_key_replica_idx',
  columns: ['sourceBackendId', 'key', 'replicaBackendId'],
  unique: true,
})
@Index({ name: 'storage_replica_copy_replica_key_idx', columns: ['replicaBackendId', 'sourceBackendId', 'key'] })
@Index({ name: 'storage_replica_copy_pending_idx', columns: ['nextAttemptAt'], where: '"completedAt" IS NULL' })
export class StorageReplicaCopyTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => StorageBackendTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  replicaBackendId!: string;

  @Column()
  sourceBackendId!: string;

  @Column()
  key!: string;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  /** When the copy was made and its size confirmed */
  @Column({ type: 'timestamp with time zone', nullable: true })
  completedAt!: Timestamp | null;

  /** Bytes on the replica, which are the bytes stored on the source (encrypted files stay encrypted) */
  @Column({ type: 'bigint', nullable: true })
  size!: Int8 | null;

  @Column({ type: 'integer', default: 0 })
  attempts!: Generated<number>;

  @Column({ type: 'timestamp with time zone', default: () => 'now()' })
  nextAttemptAt!: Generated<Timestamp>;

  /** A copy being made is held until then, so that no other worker makes it at the same time */
  @Column({ type: 'timestamp with time zone', nullable: true })
  leaseUntil!: Timestamp | null;

  @Column({ nullable: true })
  lastError!: string | null;
}
