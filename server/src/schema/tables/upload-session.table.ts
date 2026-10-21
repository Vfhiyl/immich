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
  UpdateDateColumn,
} from '@immich/sql-tools';
import type { UploadedPart } from 'src/repositories/blob-store.js';
import { UploadSessionStatus } from 'src/enum.js';
import { StorageBackendTable } from 'src/schema/tables/storage-backend.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/** What a resumable upload creates an asset with, as the client declared it when it began the upload */
export type UploadAssetData = {
  filename: string;
  fileCreatedAt: string;
  fileModifiedAt: string;
  deviceAssetId?: string;
  deviceId?: string;
  duration?: number;
  isFavorite?: boolean;
  visibility?: string;
  livePhotoVideoId?: string;
};

/**
 * A resumable upload (draft-ietf-httpbis-resumable-upload) while it is received, and for a while after, so that a
 * client that missed the response can learn the result. The parts written to the storage backend are the progress:
 * the offset only moves when a part is written and recorded here; the bytes after it wait in a staging file.
 */
@Table('upload_session')
@Index({ name: 'upload_session_expiresAt_idx', columns: ['expiresAt'] })
export class UploadSessionTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  ownerId!: string;

  @Column({ type: 'character varying' })
  status!: UploadSessionStatus;

  @Column({ type: 'jsonb' })
  assetData!: UploadAssetData;

  /** The interop version of the draft that the client follows */
  @Column({ type: 'integer', nullable: true })
  interopVersion!: number | null;

  /** The length of the whole file, once the client said it */
  @Column({ type: 'bigint', nullable: true })
  length!: Int8 | null;

  /** The SHA-1 the client declared, which the file must have */
  @Column({ type: 'bytea', nullable: true })
  declaredChecksum!: Buffer | null;

  @ForeignKeyColumn(() => StorageBackendTable, { onDelete: 'RESTRICT', onUpdate: 'CASCADE', index: false })
  backendId!: string;

  @Column()
  key!: string;

  /** The upload on the storage backend, which may be dropped by it at any time */
  @Column()
  blobUploadId!: string;

  @Column({ type: 'integer' })
  partSize!: number;

  @Column({ type: 'bytea', nullable: true })
  encryption!: Buffer | null;

  @Column({ type: 'jsonb', default: '[]' })
  parts!: Generated<UploadedPart[]>;

  /** The bytes written to the backend and recorded, which is all an upload can be resumed from for sure */
  @Column({ type: 'bigint', default: 0 })
  committedOffset!: Generated<Int8>;

  /** The SHA-1 of the committed bytes, as a saved state that hashing continues from */
  @Column({ type: 'bytea', nullable: true })
  hashState!: Buffer | null;

  @Column({ type: 'uuid', nullable: true })
  assetId!: string | null;

  @Column({ type: 'timestamp with time zone' })
  expiresAt!: Timestamp;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
