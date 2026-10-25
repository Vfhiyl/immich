import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  type Generated,
  PrimaryColumn,
  Table,
  type Timestamp,
  UpdateDateColumn,
} from '@immich/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';

/**
 * A job for an asset that has not finished: it failed, or the process stopped while it ran (as when memory ran out). The
 * row goes once the job finishes; after a few attempts in a row by one version of the server, the job is no longer
 * queued for the asset (see `JOB_FAILURE_ATTEMPTS`), until an admin retries it or another version of the server runs
 */
@Table({ name: 'asset_job_failure' })
export class AssetJobFailureTable {
  @PrimaryColumn({ type: 'character varying' })
  jobName!: string;

  @ForeignKeyColumn(() => AssetTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', primary: true })
  assetId!: string;

  @Column({ type: 'integer', default: 1 })
  attempts!: Generated<number>;

  /** Why the last attempt failed; none when the process stopped while it ran */
  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @Column()
  serverVersion!: string;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
