import { Column, CreateDateColumn, type Generated, PrimaryColumn, Table, Timestamp } from '@immich/sql-tools';
import { StorageBackendDriver } from 'src/enum.js';

/** Storage backends that files can live on. The built-in local backends are created by a migration. */
@Table('storage_backend')
export class StorageBackendTable {
  @PrimaryColumn({ type: 'character varying' })
  id!: string;

  @Column({ type: 'character varying' })
  driver!: StorageBackendDriver;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
