import { JobName } from 'src/enum.js';
import { JOB_FAILURE_ATTEMPTS } from 'src/repositories/job-failure.repository.js';
import { JobFailureService } from 'src/services/job-failure.service.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(JobFailureService.name, () => {
  let sut: JobFailureService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(JobFailureService));
  });

  it('should list the files each job failed on', async () => {
    const failedAt = new Date('2026-10-26T01:00:00.000Z');
    mocks.jobFailure.getCounts.mockResolvedValue([{ jobName: JobName.AssetGenerateThumbnails, count: 120 }]);
    mocks.jobFailure.getHeldBackAssets.mockResolvedValue([
      { assetId: 'asset-1', originalFileName: 'bad.heic', attempts: 3, error: null, failedAt },
    ]);

    await expect(sut.getFailures()).resolves.toEqual({
      attempts: JOB_FAILURE_ATTEMPTS,
      jobs: [
        {
          jobName: JobName.AssetGenerateThumbnails,
          count: 120,
          assets: [
            {
              assetId: 'asset-1',
              originalFileName: 'bad.heic',
              attempts: 3,
              error: null,
              failedAt: failedAt.toISOString(),
            },
          ],
        },
      ],
    });
    expect(mocks.jobFailure.getHeldBackAssets).toHaveBeenCalledWith(
      JobName.AssetGenerateThumbnails,
      expect.any(String),
      50,
    );
  });

  it('should queue a job again for the files it failed on, in batches', async () => {
    const assetIds = Array.from({ length: 1500 }, () => newUuid());
    mocks.jobFailure.release.mockResolvedValue(assetIds);

    await expect(sut.retry({ jobName: JobName.AssetEncodeVideo })).resolves.toEqual({ count: 1500 });

    expect(mocks.job.queueAll).toHaveBeenCalledTimes(2);
    expect(mocks.job.queueAll).toHaveBeenNthCalledWith(
      1,
      assetIds.slice(0, 1000).map((id) => ({ name: JobName.AssetEncodeVideo, data: { id } })),
    );
  });
});
