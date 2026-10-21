import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  type Generated,
  Index,
  Int8,
  PrimaryGeneratedColumn,
  Table,
  Timestamp,
  Unique,
  UpdateDateColumn,
} from '@immich/sql-tools';
import { UpdateIdColumn, UpdatedAtTrigger } from 'src/decorators.js';
import { AssetFileType, BuiltinStorageBackend } from 'src/enum.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { StorageBackendTable } from 'src/schema/tables/storage-backend.table.js';

@Table('asset_file')
@Unique({ columns: ['assetId', 'type', 'isEdited'] })
// Two files must never share a blob that Immich owns, or deleting one would delete the other. Host files are not
// owned by Immich (e.g. sidecars next to external library files that several libraries can point to), so they can.
@Index({
  name: 'asset_file_backendId_key_idx',
  columns: ['backendId', 'key'],
  unique: true,
  where: `"backendId" <> '${BuiltinStorageBackend.Host}'`,
})
@UpdatedAtTrigger('asset_file_updatedAt')
export class AssetFileTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  assetId!: string;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @Column()
  type!: AssetFileType;

  @Column()
  path!: string;

  @ForeignKeyColumn(() => StorageBackendTable, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: true,
    // backends are practically never deleted, so the restrict check does not need an index
    index: false,
  })
  backendId!: string | null;

  /** Location of the file within its storage backend */
  @Column({ nullable: true })
  key!: string | null;

  @Column({ type: 'bigint', nullable: true })
  size!: Int8 | null;

  /** SHA-1 of the file contents */
  @Column({ type: 'bytea', nullable: true })
  checksum!: Buffer | null;

  /** For an encrypted file, the header that reading it needs (the key it was encrypted with, wrapped) */
  @Column({ type: 'bytea', nullable: true })
  encryption!: Buffer | null;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;

  @Column({ type: 'boolean', default: false })
  isEdited!: Generated<boolean>;

  @Column({ type: 'boolean', default: false })
  isProgressive!: Generated<boolean>;

  @Column({ type: 'boolean', default: false })
  isTransparent!: Generated<boolean>;
}
