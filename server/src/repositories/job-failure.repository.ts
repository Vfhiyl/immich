import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { JobName } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { TrackedJobName } from 'src/utils/job-failure.js';

/** Attempts in a row of a job for an asset, by one version of the server, after which the job is held back */
export const JOB_FAILURE_ATTEMPTS = 3;

/** How much of the error of a failed job is kept */
const ERROR_LENGTH = 2000;

/**
 * Jobs for assets that did not finish. A job that fails on an asset again and again (a file that cannot be decoded, or
 * one that makes the process run out of memory) is held back after a few attempts, instead of being queued again
 * every night: like the dead-letter queue of a message queue, which an admin redrives
 */
@Injectable()
export class JobFailureRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** A job starts on an asset: one attempt more, which stays should the process stop before the job ends */
  @GenerateSql({ params: [JobName.AssetGenerateThumbnails, DummyValue.UUID, DummyValue.STRING] })
  async start(jobName: JobName, assetId: string, serverVersion: string): Promise<void> {
    await this.db
      .insertInto('asset_job_failure')
      .columns(['jobName', 'assetId', 'serverVersion'])
      // the asset may be gone already
      .expression((eb) =>
        eb
          .selectFrom('asset')
          .select([eb.val(jobName).as('jobName'), 'asset.id', eb.val(serverVersion).as('serverVersion')])
          .where('asset.id', '=', assetId),
      )
      .onConflict((oc) =>
        oc.columns(['jobName', 'assetId']).doUpdateSet((eb) => ({
          // another version of the server starts counting again
          attempts: sql<number>`case when ${eb.ref('asset_job_failure.serverVersion')} = ${eb.ref('excluded.serverVersion')} then ${eb.ref('asset_job_failure.attempts')} + 1 else 1 end`,
          serverVersion: eb.ref('excluded.serverVersion'),
          error: null,
          updatedAt: sql`now()`,
        })),
      )
      .execute();
  }

  /** The job finished on the asset */
  @GenerateSql({ params: [JobName.AssetGenerateThumbnails, DummyValue.UUID] })
  async finish(jobName: JobName, assetId: string): Promise<void> {
    await this.db
      .deleteFrom('asset_job_failure')
      .where('jobName', '=', jobName)
      .where('assetId', '=', assetId)
      .execute();
  }

  /** The job failed on the asset */
  @GenerateSql({ params: [JobName.AssetGenerateThumbnails, DummyValue.UUID, DummyValue.STRING] })
  async fail(jobName: JobName, assetId: string, error: string): Promise<void> {
    await this.db
      .updateTable('asset_job_failure')
      .set({ error: error.slice(0, ERROR_LENGTH), updatedAt: sql`now()` })
      .where('jobName', '=', jobName)
      .where('assetId', '=', assetId)
      .execute();
  }

  /** Of these assets, those the job is held back from */
  @GenerateSql({ params: [JobName.AssetGenerateThumbnails, [DummyValue.UUID], DummyValue.STRING] })
  async getHeldBack(jobName: JobName, assetIds: string[], serverVersion: string): Promise<string[]> {
    if (assetIds.length === 0) {
      return [];
    }
    const rows = await this.db
      .selectFrom('asset_job_failure')
      .select('assetId')
      .where('jobName', '=', jobName)
      .where('assetId', '=', sql<string>`any(${sql.val(assetIds)}::uuid[])`)
      .where('attempts', '>=', JOB_FAILURE_ATTEMPTS)
      .where('serverVersion', '=', serverVersion)
      .execute();
    return rows.map(({ assetId }) => assetId);
  }

  /** How many assets each job is held back from */
  @GenerateSql({ params: [DummyValue.STRING] })
  getCounts(serverVersion: string) {
    return this.db
      .selectFrom('asset_job_failure')
      .select(['jobName', (eb) => eb.fn.countAll<number>().as('count')])
      .where('attempts', '>=', JOB_FAILURE_ATTEMPTS)
      .where('serverVersion', '=', serverVersion)
      .groupBy('jobName')
      .orderBy('jobName')
      .$narrowType<{ jobName: TrackedJobName }>()
      .execute();
  }

  /** The assets a job is held back from, those that failed last first */
  @GenerateSql({ params: [JobName.AssetGenerateThumbnails, DummyValue.STRING, 50] })
  getHeldBackAssets(jobName: JobName, serverVersion: string, limit: number) {
    return this.db
      .selectFrom('asset_job_failure')
      .innerJoin('asset', 'asset.id', 'asset_job_failure.assetId')
      .select([
        'asset_job_failure.assetId',
        'asset.originalFileName',
        'asset_job_failure.attempts',
        'asset_job_failure.error',
        'asset_job_failure.updatedAt as failedAt',
      ])
      .where('asset_job_failure.jobName', '=', jobName)
      .where('asset_job_failure.attempts', '>=', JOB_FAILURE_ATTEMPTS)
      .where('asset_job_failure.serverVersion', '=', serverVersion)
      .orderBy('asset_job_failure.updatedAt', 'desc')
      .limit(limit)
      .execute();
  }

  /** No longer holds a job back from the assets, which are returned: it is tried again from the first attempt */
  @GenerateSql({ params: [JobName.AssetGenerateThumbnails, DummyValue.STRING] })
  async release(jobName: JobName, serverVersion: string): Promise<string[]> {
    const rows = await this.db
      .deleteFrom('asset_job_failure')
      .where('jobName', '=', jobName)
      .where('attempts', '>=', JOB_FAILURE_ATTEMPTS)
      .where('serverVersion', '=', serverVersion)
      .returning('assetId')
      .execute();
    return rows.map(({ assetId }) => assetId);
  }
}
