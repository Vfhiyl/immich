import {
  Column,
  CreateDateColumn,
  type Generated,
  Index,
  type Int8,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  Table,
  type Timestamp,
} from '@immich/sql-tools';
import { StorageCheckKind, StorageCheckStatus, StorageIssueKind } from 'src/enum.js';

export type StorageCheckStats = {
  /** Backends that were checked */
  backends: string[];
  /** Objects listed (reconciliation) or files read back (verification) */
  checked: number;
  bytes: number;
  /** Issues confirmed by this run, and all issues open after it */
  newIssues: number;
  openIssues: number;
  /** Why a run did not cover everything, e.g. its time limit */
  stoppedBecause?: string;
};

/** A run of a storage check: one report of the report center */
@Table('storage_check_run')
@Index({ name: 'storage_check_run_startedAt_idx', columns: ['startedAt'] })
export class StorageCheckRunTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @Column({ type: 'character varying' })
  kind!: StorageCheckKind;

  @Column({ type: 'character varying' })
  status!: StorageCheckStatus;

  @CreateDateColumn()
  startedAt!: Generated<Timestamp>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  finishedAt!: Timestamp | null;

  @Column({ type: 'jsonb' })
  stats!: StorageCheckStats;
}

/**
 * A problem a storage check found with a file. It is only reported once seen by two runs in a row, so that what a
 * service shows a little late (it only promises to be eventually consistent) is not reported; it is resolved once a run
 * no longer sees it. Checks report, they never delete or change anything.
 */
@Table('storage_issue')
@Index({
  name: 'storage_issue_open_idx',
  columns: ['backendId', 'key', 'kind'],
  unique: true,
  where: '"resolvedAt" IS NULL',
})
@Index({ name: 'storage_issue_firstSeenAt_idx', columns: ['firstSeenAt'] })
export class StorageIssueTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @Column()
  backendId!: string;

  @Column()
  key!: string;

  @Column({ type: 'character varying' })
  kind!: StorageIssueKind;

  @Column({ nullable: true })
  detail!: string | null;

  @CreateDateColumn()
  firstSeenAt!: Generated<Timestamp>;

  @Column({ type: 'timestamp with time zone' })
  lastSeenAt!: Timestamp;

  @Column({ type: 'integer', default: 1 })
  sightings!: Generated<number>;

  /** When a second run saw it: from then on it is reported */
  @Column({ type: 'timestamp with time zone', nullable: true })
  confirmedAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  resolvedAt!: Timestamp | null;

  /** An administrator saw it and noted so, which does not resolve it */
  @Column({ type: 'timestamp with time zone', nullable: true })
  acknowledgedAt!: Timestamp | null;
}

/** What a reconciliation listed of a backend, compared with what is recorded once the listing is complete */
@Table('storage_listing')
export class StorageListingTable {
  @PrimaryColumn()
  backendId!: string;

  @PrimaryColumn()
  key!: string;

  @Column({ type: 'bigint' })
  size!: Int8;

  @Column({ type: 'timestamp with time zone' })
  lastModified!: Timestamp;
}

/** When a file was last read back and verified, and whether that worked */
@Table('storage_verification')
@Index({ name: 'storage_verification_verifiedAt_idx', columns: ['verifiedAt'] })
export class StorageVerificationTable {
  @PrimaryColumn()
  backendId!: string;

  @PrimaryColumn()
  key!: string;

  @Column({ type: 'timestamp with time zone' })
  verifiedAt!: Timestamp;

  @Column({ type: 'boolean' })
  ok!: boolean;
}
