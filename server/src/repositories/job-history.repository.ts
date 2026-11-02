import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { DB } from 'src/schema/index.js';
import { JobFailureRecord, JobHistoryRecorder, JobRunCount } from 'src/utils/job-history.js';

/** The unit of the buckets of a series of the jobs that ran */
export type JobHistoryUnit = 'hour' | 'day' | 'month';

export interface JobFailureFilter {
  since?: Date;
  jobName?: string;
  category?: string;
  reason?: string;
}

/**
 * The jobs that ran and failed over time, for the admin: counts per hour and job, and each failure with its reason.
 * Counted in memory as jobs end (see JobHistoryRecorder), written by `flush`
 */
@Injectable()
export class JobHistoryRepository {
  private recorder = new JobHistoryRecorder();

  constructor(@InjectKysely() private db: Kysely<DB>) {}

  record(...args: Parameters<JobHistoryRecorder['record']>) {
    this.recorder.record(...args);
  }

  /** Writes what was counted since the last time; what cannot be written is lost (these are statistics) */
  async flush() {
    const { counts, failures } = this.recorder.drain();
    await this.addRuns(counts);
    await this.addFailures(failures);
  }

  @GenerateSql({ params: [[]] })
  async addRuns(counts: JobRunCount[]) {
    if (counts.length === 0) {
      return;
    }
    await this.db
      .insertInto('job_run_hourly')
      .values(counts.map(({ hour, ...count }) => ({ hour: new Date(hour), ...count })))
      .onConflict((oc) =>
        oc.columns(['hour', 'jobName']).doUpdateSet((eb) => ({
          succeeded: eb('job_run_hourly.succeeded', '+', eb.ref('excluded.succeeded')),
          failed: eb('job_run_hourly.failed', '+', eb.ref('excluded.failed')),
          retried: eb('job_run_hourly.retried', '+', eb.ref('excluded.retried')),
        })),
      )
      .execute();
  }

  @GenerateSql({ params: [[]] })
  async addFailures(failures: JobFailureRecord[]) {
    if (failures.length === 0) {
      return;
    }
    await this.db.insertInto('job_failure_log').values(failures).execute();
  }

  /** The jobs that ran since `since` (all of them without), per job */
  @GenerateSql({ params: [DummyValue.DATE] })
  getTotals(since?: Date) {
    return this.db
      .selectFrom('job_run_hourly')
      .select((eb) => [
        'jobName',
        eb.fn.max('queueName').as('queueName'),
        eb.fn.sum<number>('succeeded').as('succeeded'),
        eb.fn.sum<number>('failed').as('failed'),
        eb.fn.sum<number>('retried').as('retried'),
      ])
      .$if(!!since, (qb) => qb.where('hour', '>=', since!))
      .groupBy('jobName')
      .orderBy('jobName')
      .execute();
  }

  /** The jobs that ran since `since`, all together, per `unit` (UTC) */
  @GenerateSql({ params: [DummyValue.DATE, 'hour'] })
  getSeries(since: Date | undefined, unit: JobHistoryUnit) {
    const bucket = sql<Date>`date_trunc(${sql.lit(unit)}, "hour", 'UTC')`;
    return this.db
      .selectFrom('job_run_hourly')
      .select((eb) => [
        bucket.as('start'),
        eb.fn.sum<number>('succeeded').as('succeeded'),
        eb.fn.sum<number>('failed').as('failed'),
        eb.fn.sum<number>('retried').as('retried'),
      ])
      .$if(!!since, (qb) => qb.where('hour', '>=', since!))
      .groupBy(bucket)
      .orderBy(bucket)
      .execute();
  }

  /** The reasons jobs failed for since `since`, the most frequent first, with the last failure of each */
  @GenerateSql({ params: [DummyValue.DATE, 50] })
  getReasons(since: Date | undefined, limit: number) {
    return this.db
      .selectFrom('job_failure_log')
      .select((eb) => [
        'jobName',
        'category',
        'reason',
        eb.fn.countAll<number>().as('count'),
        eb.fn.max('createdAt').as('lastAt'),
      ])
      .$if(!!since, (qb) => qb.where('createdAt', '>=', since!))
      .groupBy(['jobName', 'category', 'reason'])
      .orderBy('count', 'desc')
      .orderBy('lastAt', 'desc')
      .limit(limit)
      .execute();
  }

  /** The failures since `since`, the last first, a page of them */
  @GenerateSql({ params: [{ since: DummyValue.DATE }, 50, 0] })
  getFailures({ since, jobName, category, reason }: JobFailureFilter, limit: number, offset: number) {
    return this.db
      .selectFrom('job_failure_log')
      .leftJoin('asset', 'asset.id', 'job_failure_log.assetId')
      .select([
        'job_failure_log.id',
        'job_failure_log.createdAt',
        'job_failure_log.jobName',
        'job_failure_log.category',
        'job_failure_log.reason',
        'job_failure_log.error',
        'job_failure_log.assetId',
        'asset.originalFileName',
      ])
      .$if(!!since, (qb) => qb.where('job_failure_log.createdAt', '>=', since!))
      .$if(!!jobName, (qb) => qb.where('job_failure_log.jobName', '=', jobName!))
      .$if(!!category, (qb) => qb.where('job_failure_log.category', '=', category!))
      .$if(!!reason, (qb) => qb.where('job_failure_log.reason', '=', reason!))
      .orderBy('job_failure_log.createdAt', 'desc')
      .orderBy('job_failure_log.id', 'desc')
      .limit(limit)
      .offset(offset)
      .execute();
  }

  /** Of the failures since `since` that match, how many */
  @GenerateSql({ params: [{ since: DummyValue.DATE }] })
  async countFailures({ since, jobName, category, reason }: JobFailureFilter) {
    const { count } = await this.db
      .selectFrom('job_failure_log')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .$if(!!since, (qb) => qb.where('createdAt', '>=', since!))
      .$if(!!jobName, (qb) => qb.where('jobName', '=', jobName!))
      .$if(!!category, (qb) => qb.where('category', '=', category!))
      .$if(!!reason, (qb) => qb.where('reason', '=', reason!))
      .executeTakeFirstOrThrow();
    return Number(count);
  }

  /** Keeps the failures of the last `days` days, at most `rows` of them (the last); the counts are kept for good */
  @GenerateSql({ params: [365, 200_000] })
  async removeOldFailures(days: number, rows: number) {
    await this.db
      .deleteFrom('job_failure_log')
      .where('createdAt', '<', sql<Date>`now() - make_interval(days => ${days})`)
      .execute();
    await this.db
      .deleteFrom('job_failure_log')
      .where('id', 'in', (eb) =>
        eb.selectFrom('job_failure_log').select('id').orderBy('createdAt', 'desc').orderBy('id', 'desc').offset(rows),
      )
      .execute();
  }
}
