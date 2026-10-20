import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  type Generated,
  Index,
  Int8,
  Table,
  Timestamp,
} from '@immich/sql-tools';
import { BuiltinStorageBackend } from 'src/enum.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { StorageBackendTable } from 'src/schema/tables/storage-backend.table.js';

/**
 * Where the original file of an asset is stored. Kept apart from the asset table so that recording a location does
 * not touch the asset row, which would make every client sync the asset again.
 */
@Table('asset_original_file')
// see asset_file: blobs that Immich owns are never shared, host files may be
@Index({
  name: 'asset_original_file_backendId_key_idx',
  columns: ['backendId', 'key'],
  unique: true,
  where: `"backendId" <> '${BuiltinStorageBackend.Host}'`,
})
export class AssetOriginalFileTable {
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true })
  assetId!: string;

  @ForeignKeyColumn(() => StorageBackendTable, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    // backends are practically never deleted, so the restrict check does not need an index
    index: false,
  })
  backendId!: string;

  /** Location of the file within its storage backend */
  @Column()
  key!: string;

  @Column({ type: 'bigint', nullable: true })
  size!: Int8 | null;

  /** SHA-1 of the file contents */
  @Column({ type: 'bytea', nullable: true })
  checksum!: Buffer | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
