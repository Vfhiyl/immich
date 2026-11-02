import { Kysely } from 'kysely';
import { JobHistoryRepository } from 'src/repositories/job-history.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { JobFailureCategory } from 'src/utils/job-history.js';
import { newMediumService } from 'test/medium.factory.js';
import { getTestKyselyDB } from 'test/utils.js';

const hour = (iso: string) => new Date(iso);

const runs = (time: string, jobName: string, succeeded: number, failed: number, retried = 0) => ({
  hour: time,
  jobName,
  queueName: 'thumbnailGeneration',
  succeeded,
  failed,
  retried,
});

const failure = (
  createdAt: string,
  reason: string,
  category = JobFailureCategory.File,
  assetId: string | null = null,
) => ({
  createdAt: new Date(createdAt),
  jobName: 'AssetGenerateThumbnails',
  queueName: 'thumbnailGeneration',
  assetId,
  category,
  reason,
  error: `${reason}!`,
});

// a failure of so many days ago
const old = (days: number) => ({
  createdAt: new Date(Date.now() - days * 24 * 60 * 60 * 1000),
  jobName: 'Ocr',
  queueName: 'ocr',
  assetId: null,
  category: JobFailureCategory.File,
  reason: 'x',
  error: 'x',
});

const setup = async () => {
  const db: Kysely<DB> = await getTestKyselyDB();
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id, originalFileName: 'IMG_1.HEIC' });
  return { db, sut: ctx.get(JobHistoryRepository), asset };
};

describe(JobHistoryRepository.name, () => {
  it('should add up the jobs of an hour written at different times, and sum them per job and over time', async () => {
    const { sut } = await setup();

    await sut.addRuns([runs('2026-11-01T10:00:00Z', 'AssetGenerateThumbnails', 10, 1)]);
    await sut.addRuns([
      runs('2026-11-01T10:00:00Z', 'AssetGenerateThumbnails', 5, 2),
      runs('2026-11-01T11:00:00Z', 'AssetGenerateThumbnails', 3, 0, 4),
      runs('2026-11-02T09:00:00Z', 'SmartSearch', 7, 7),
    ]);

    await expect(sut.getTotals()).resolves.toEqual([
      {
        jobName: 'AssetGenerateThumbnails',
        queueName: 'thumbnailGeneration',
        succeeded: 18,
        failed: 3,
        retried: 4,
      },
      { jobName: 'SmartSearch', queueName: 'thumbnailGeneration', succeeded: 7, failed: 7, retried: 0 },
    ]);
    await expect(sut.getTotals(hour('2026-11-01T11:00:00Z'))).resolves.toMatchObject([
      { jobName: 'AssetGenerateThumbnails', succeeded: 3 },
      { jobName: 'SmartSearch', succeeded: 7 },
    ]);
    const days = await sut.getSeries(undefined, 'day');
    expect(days.map(({ start, succeeded, failed }) => [new Date(start).toISOString(), succeeded, failed])).toEqual([
      ['2026-11-01T00:00:00.000Z', 18, 3],
      ['2026-11-02T00:00:00.000Z', 7, 7],
    ]);
    await expect(sut.getSeries(hour('2026-11-01T11:00:00Z'), 'hour')).resolves.toHaveLength(2);
  });

  it('should group failures by their reason, and list them with their asset by job, kind and reason', async () => {
    const { sut, asset } = await setup();
    await sut.addFailures([
      failure('2026-11-01T10:00:00Z', 'cannot decode', JobFailureCategory.File, asset.id),
      failure('2026-11-01T11:00:00Z', 'cannot decode'),
      failure('2026-11-02T10:00:00Z', 'killed', JobFailureCategory.OutOfMemory),
    ]);

    await expect(sut.getReasons(undefined, 50)).resolves.toEqual([
      {
        jobName: 'AssetGenerateThumbnails',
        category: 'file',
        reason: 'cannot decode',
        count: 2,
        lastAt: hour('2026-11-01T11:00:00Z'),
      },
      {
        jobName: 'AssetGenerateThumbnails',
        category: 'out_of_memory',
        reason: 'killed',
        count: 1,
        lastAt: hour('2026-11-02T10:00:00Z'),
      },
    ]);
    const decode = { reason: 'cannot decode' };
    await expect(sut.countFailures(decode)).resolves.toBe(2);
    const [last, first] = await sut.getFailures(decode, 50, 0);
    expect(last).toMatchObject({ assetId: null, originalFileName: null, error: 'cannot decode!' });
    expect(first).toMatchObject({ assetId: asset.id, originalFileName: 'IMG_1.HEIC' });
    await expect(sut.getFailures({ category: JobFailureCategory.OutOfMemory }, 50, 0)).resolves.toHaveLength(1);
    await expect(sut.getFailures({ since: hour('2026-11-02T00:00:00Z') }, 50, 0)).resolves.toHaveLength(1);
    await expect(sut.getFailures({}, 1, 1)).resolves.toMatchObject([{ createdAt: hour('2026-11-01T11:00:00Z') }]);
  });

  it('should keep the failures of the last days, at most so many, the last', async () => {
    const { sut } = await setup();
    await sut.addFailures([old(400), old(3), old(2), old(1)]);

    await sut.removeOldFailures(365, 2);

    const kept = await sut.getFailures({}, 50, 0);
    expect(kept).toHaveLength(2);
    expect(kept[0].createdAt.getTime()).toBeGreaterThan(kept[1].createdAt.getTime());
    await expect(sut.countFailures({})).resolves.toBe(2);
  });
});
