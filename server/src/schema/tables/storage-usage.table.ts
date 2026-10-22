import { Column, type Int8, PrimaryColumn, Table } from '@immich/sql-tools';
import { StorageUsageCategory } from 'src/enum.js';

/** Requests to the storage service of a backend, per UTC day, operation and purpose (the job, or `api`) */
@Table('storage_request_usage')
export class StorageRequestUsageTable {
  @PrimaryColumn({ type: 'date' })
  day!: string;

  @PrimaryColumn()
  backendId!: string;

  /** The request, as the S3 protocol names it, e.g. PutObject */
  @PrimaryColumn()
  operation!: string;

  @PrimaryColumn()
  purpose!: string;

  @Column({ type: 'bigint' })
  requests!: Int8;

  @Column({ type: 'bigint' })
  bytesSent!: Int8;

  @Column({ type: 'bigint' })
  bytesReceived!: Int8;
}

/** What a backend stored on a UTC day, by category, as recorded in the database */
@Table('storage_usage_daily')
export class StorageUsageDailyTable {
  @PrimaryColumn({ type: 'date' })
  day!: string;

  @PrimaryColumn()
  backendId!: string;

  @PrimaryColumn({ type: 'character varying' })
  category!: StorageUsageCategory;

  @Column({ type: 'bigint' })
  objects!: Int8;

  @Column({ type: 'bigint' })
  bytes!: Int8;
}
