import {
  Column,
  CreateDateColumn,
  type Generated,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  Table,
  type Timestamp,
} from '@immich/sql-tools';

/**
 * The jobs that ran, per hour (UTC) and job: those that succeeded (or had nothing to do), failed, or were put back for
 * later as their environment failed (the machine learning service, the disk, a storage service). Counted as jobs end
 * and written every few seconds; kept for good (a year is some 400,000 rows)
 */
@Table('job_run_hourly')
export class JobRunHourlyTable {
  @PrimaryColumn({ type: 'timestamp with time zone' })
  hour!: Timestamp;

  @PrimaryColumn({ type: 'character varying' })
  jobName!: string;

  @Column({ type: 'character varying' })
  queueName!: string;

  @Column({ type: 'integer', default: 0 })
  succeeded!: Generated<number>;

  @Column({ type: 'integer', default: 0 })
  failed!: Generated<number>;

  @Column({ type: 'integer', default: 0 })
  retried!: Generated<number>;
}

/** A job that failed: when, on what (an asset, if it is for one), of what kind, and why */
@Table('job_failure_log')
@Index({ columns: ['createdAt'] })
@Index({ columns: ['jobName', 'createdAt'] })
export class JobFailureLogTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @Column({ type: 'character varying' })
  jobName!: string;

  @Column({ type: 'character varying' })
  queueName!: string;

  /** The asset of the job, if it is for one (not a foreign key: the failure stays after the asset is gone) */
  @Column({ type: 'uuid', nullable: true })
  assetId!: string | null;

  /** file, stuck, out_of_memory or environment (see classifyJobFailure) */
  @Column({ type: 'character varying' })
  category!: string;

  /** The error, without what differs from one asset to another (ids, paths, numbers): what failures are grouped by */
  @Column({ type: 'text' })
  reason!: string;

  @Column({ type: 'text' })
  error!: string;
}
