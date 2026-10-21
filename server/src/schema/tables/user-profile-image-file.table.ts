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
import { StorageBackendTable } from 'src/schema/tables/storage-backend.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/** Where the profile image of a user is stored; kept apart from the user table for the same reason as asset originals */
@Table('user_profile_image_file')
// see asset_file: blobs that Immich owns are never shared, host files may be
@Index({
  name: 'user_profile_image_file_backendId_key_idx',
  columns: ['backendId', 'key'],
  unique: true,
  where: `"backendId" <> '${BuiltinStorageBackend.Host}'`,
})
export class UserProfileImageFileTable {
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true })
  userId!: string;

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
