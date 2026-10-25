import { Kysely } from 'kysely';
import { JobName } from 'src/enum.js';
import { JOB_FAILURE_ATTEMPTS, JobFailureRepository } from 'src/repositories/job-failure.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getTestKyselyDB } from 'test/utils.js';

const job = JobName.AssetGenerateThumbnails;

const setup = async () => {
  const db: Kysely<DB> = await getTestKyselyDB();
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const newAsset = async (originalFileName = 'photo.jpg') => {
    const { asset } = await ctx.newAsset({ ownerId: user.id, originalFileName });
    return asset.id;
  };
  const sut = ctx.get(JobFailureRepository);
  /** Attempts that ended as the process stopped */
  const attempt = async (assetId: string, times: number, version = '3.3.5') => {
    for (let index = 0; index < times; index++) {
      await sut.start(job, assetId, version);
    }
  };
  return { db, sut, newAsset, attempt };
};

describe(JobFailureRepository.name, () => {
  it('should hold a job back from an asset after attempts in a row that did not finish', async () => {
    const { sut, newAsset, attempt } = await setup();
    const [bad, good] = [await newAsset('bad.heic'), await newAsset()];

    await attempt(bad, JOB_FAILURE_ATTEMPTS - 1);
    await attempt(good, 1);
    await expect(sut.getHeldBack(job, [bad, good], '3.3.5')).resolves.toEqual([]);

    await attempt(bad, 1);
    await sut.fail(job, bad, 'cannot decode');
    await attempt(good, JOB_FAILURE_ATTEMPTS - 1);
    // the job finished on it the last time
    await sut.finish(job, good);

    await expect(sut.getHeldBack(job, [bad, good], '3.3.5')).resolves.toEqual([bad]);
    await expect(sut.getHeldBack(JobName.AssetEncodeVideo, [bad], '3.3.5')).resolves.toEqual([]);
    await expect(sut.getCounts('3.3.5')).resolves.toEqual([{ jobName: job, count: 1 }]);
    await expect(sut.getHeldBackAssets(job, '3.3.5', 50)).resolves.toEqual([
      {
        assetId: bad,
        originalFileName: 'bad.heic',
        attempts: JOB_FAILURE_ATTEMPTS,
        error: 'cannot decode',
        failedAt: expect.any(Date),
      },
    ]);
  });

  it('should try again with another version of the server', async () => {
    const { sut, newAsset, attempt } = await setup();
    const assetId = await newAsset();
    await attempt(assetId, JOB_FAILURE_ATTEMPTS);

    await expect(sut.getHeldBack(job, [assetId], '3.4.0')).resolves.toEqual([]);
    await expect(sut.getCounts('3.4.0')).resolves.toEqual([]);

    await attempt(assetId, 1, '3.4.0');
    await expect(sut.getHeldBack(job, [assetId], '3.4.0')).resolves.toEqual([]);
  });

  it('should keep no reason for an attempt that did not end', async () => {
    const { sut, newAsset, attempt } = await setup();
    const assetId = await newAsset();
    await attempt(assetId, 1);
    await sut.fail(job, assetId, 'x'.repeat(5000));
    await attempt(assetId, JOB_FAILURE_ATTEMPTS - 1);

    const [asset] = await sut.getHeldBackAssets(job, '3.3.5', 50);
    expect(asset.error).toBeNull();

    await sut.fail(job, assetId, 'x'.repeat(5000));
    const [failed] = await sut.getHeldBackAssets(job, '3.3.5', 50);
    expect(failed.error).toHaveLength(2000);
  });

  it('should release the assets for an admin to retry', async () => {
    const { sut, newAsset, attempt } = await setup();
    const [first, second, trying] = [await newAsset(), await newAsset(), await newAsset()];
    await attempt(first, JOB_FAILURE_ATTEMPTS);
    await attempt(second, JOB_FAILURE_ATTEMPTS);
    await attempt(trying, 1);

    const released = await sut.release(job, '3.3.5');

    expect(released.toSorted()).toEqual([first, second].toSorted());
    await expect(sut.getHeldBack(job, [first, second], '3.3.5')).resolves.toEqual([]);
    await attempt(first, 1);
    await expect(sut.getHeldBack(job, [first], '3.3.5')).resolves.toEqual([]);
  });

  it('should not track an asset that is gone', async () => {
    const { db, sut, newAsset } = await setup();
    const assetId = await newAsset();
    await db.deleteFrom('asset').where('id', '=', assetId).execute();

    await sut.start(job, assetId, '3.3.5');

    await expect(db.selectFrom('asset_job_failure').selectAll().execute()).resolves.toEqual([]);
  });
});
