import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  ForeignKeyConstraint,
  type Generated,
  Index,
  Int8,
  PrimaryColumn,
  Table,
  Timestamp,
} from '@immich/sql-tools';
import { BuiltinStorageBackend } from 'src/enum.js';
import { PersonTable } from 'src/schema/tables/person.table.js';
import { StorageBackendTable } from 'src/schema/tables/storage-backend.table.js';

/** Where the thumbnail of a person is stored; kept apart from the person table for the same reason as asset originals */
@Table('person_thumbnail_file')
@ForeignKeyConstraint({
  columns: ['ownerId', 'personGroupId'],
  referenceColumns: ['ownerId', 'personGroupId'],
  referenceTable: () => PersonTable,
  // a person can move to another group, and its thumbnail moves with it
  onUpdate: 'CASCADE',
  onDelete: 'CASCADE',
  // the primary key covers these columns
  index: false,
})
// see asset_file: blobs that Immich owns are never shared, host files may be
@Index({
  name: 'person_thumbnail_file_backendId_key_idx',
  columns: ['backendId', 'key'],
  unique: true,
  where: `"backendId" <> '${BuiltinStorageBackend.Host}'`,
})
export class PersonThumbnailFileTable {
  @PrimaryColumn({ type: 'uuid' })
  ownerId!: string;

  @PrimaryColumn({ type: 'uuid' })
  personGroupId!: string;

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

  /** For an encrypted file, the header that reading it needs (the key it was encrypted with, wrapped) */
  @Column({ type: 'bytea', nullable: true })
  encryption!: Buffer | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
