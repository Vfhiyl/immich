import { CreateDateColumn, type Generated, PrimaryColumn, Table, Timestamp } from '@immich/sql-tools';

/**
 * Master keys that have encrypted files, by id (never the key itself). Every one of them must stay available, so a key
 * file that lost a key is noticed at startup rather than when a file cannot be read.
 */
@Table('storage_master_key')
export class StorageMasterKeyTable {
  @PrimaryColumn({ type: 'bytea' })
  id!: Buffer;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
