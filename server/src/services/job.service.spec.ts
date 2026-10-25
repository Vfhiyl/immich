import type { JobItem } from 'src/types.js';
import { AssetType, ImmichWorker, JobName, JobStatus, QueueName } from 'src/enum.js';
import { JobService } from 'src/services/job.service.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(JobService.name, () => {
  let sut: JobService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(JobService));

    mocks.config.getWorker.mockReturnValue(ImmichWorker.Microservices);
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('onJobRun', () => {
    it('should queue metadata extraction when sidecar discovery is skipped', async () => {
      const job: JobItem = { name: JobName.SidecarCheck, data: { id: 'asset-1', source: 'upload' } };
      mocks.job.run.mockResolvedValue(JobStatus.Skipped);

      await sut.onJobRun(QueueName.Sidecar, job);

      expect(mocks.job.queue).toHaveBeenCalledExactlyOnceWith({
        name: JobName.AssetExtractMetadata,
        data: job.data,
      });
    });

    it('should process a successful job', async () => {
      mocks.job.run.mockResolvedValue(JobStatus.Success);

      const job: JobItem = { name: JobName.FileDelete, data: { files: ['path/to/file'] } };
      await sut.onJobRun(QueueName.BackgroundTask, job);

      expect(mocks.event.emit).toHaveBeenCalledWith('JobStart', QueueName.BackgroundTask, job);
      expect(mocks.event.emit).toHaveBeenCalledWith('JobSuccess', { job, response: JobStatus.Success });
      expect(mocks.event.emit).toHaveBeenCalledWith('JobComplete', QueueName.BackgroundTask, job);
      expect(mocks.logger.error).not.toHaveBeenCalled();
    });

    it('should fail in its queue when a job throws', async () => {
      const error = new Error('cannot decode');
      mocks.job.run.mockRejectedValue(error);

      const job: JobItem = { name: JobName.FileDelete, data: { files: ['path/to/file'] } };
      await expect(sut.onJobRun(QueueName.BackgroundTask, job)).rejects.toBe(error);

      expect(mocks.event.emit).toHaveBeenCalledWith('JobError', { job, error });
      expect(mocks.event.emit).toHaveBeenCalledWith('JobComplete', QueueName.BackgroundTask, job);
      expect(mocks.jobFailure.start).not.toHaveBeenCalled();
    });

    it('should track a job for a file from before it starts until it finishes', async () => {
      mocks.job.run.mockResolvedValue(JobStatus.Success);
      const job: JobItem = { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1' } };

      await sut.onJobRun(QueueName.ThumbnailGeneration, job);

      expect(mocks.jobFailure.start).toHaveBeenCalledWith(
        JobName.AssetGenerateThumbnails,
        'asset-1',
        expect.any(String),
      );
      expect(mocks.jobFailure.finish).toHaveBeenCalledWith(JobName.AssetGenerateThumbnails, 'asset-1');
      expect(mocks.jobFailure.fail).not.toHaveBeenCalled();
      expect(mocks.jobFailure.start.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.job.run.mock.invocationCallOrder[0],
      );
    });

    it('should record why a job for a file failed', async () => {
      mocks.job.run.mockRejectedValue(new Error('cannot decode'));
      const job: JobItem = { name: JobName.AssetEncodeVideo, data: { id: 'asset-1' } };

      await expect(sut.onJobRun(QueueName.VideoConversion, job)).rejects.toThrow('cannot decode');

      expect(mocks.jobFailure.fail).toHaveBeenCalledWith(JobName.AssetEncodeVideo, 'asset-1', 'cannot decode');
      expect(mocks.jobFailure.finish).not.toHaveBeenCalled();
    });

    it('should record a job for a file that returned failed', async () => {
      mocks.job.run.mockResolvedValue(JobStatus.Failed);
      const job: JobItem = { name: JobName.SmartSearch, data: { id: 'asset-1' } };

      await expect(sut.onJobRun(QueueName.SmartSearch, job)).rejects.toThrow();

      expect(mocks.jobFailure.fail).toHaveBeenCalledWith(JobName.SmartSearch, 'asset-1', expect.any(String));
      expect(mocks.event.emit).not.toHaveBeenCalledWith('JobError', expect.anything());
    });

    it('should store a new database backup on the storage backend for backups', async () => {
      mocks.job.run.mockResolvedValue(JobStatus.Success);

      await sut.onJobRun(QueueName.BackupDatabase, { name: JobName.DatabaseBackup });

      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.DatabaseBackupStore });
    });

    const tests: Array<{ item: JobItem; jobs: JobName[]; stub?: any }> = [
      {
        item: { name: JobName.SidecarCheck, data: { id: 'asset-1' } },
        jobs: [JobName.AssetExtractMetadata],
      },
      {
        item: { name: JobName.SidecarCheck, data: { id: 'asset-1' } },
        jobs: [JobName.AssetExtractMetadata],
      },
      {
        item: { name: JobName.StorageTemplateMigrationSingle, data: { id: 'asset-1', source: 'upload' } },
        jobs: [JobName.AssetGenerateThumbnails],
      },
      {
        item: { name: JobName.StorageTemplateMigrationSingle, data: { id: 'asset-1' } },
        jobs: [],
      },
      {
        item: { name: JobName.PersonGenerateThumbnail, data: { ownerId: 'owner-1', personGroupId: 'person-group-1' } },
        jobs: [],
      },
      {
        item: { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1' } },
        jobs: [],
        stub: [AssetFactory.create({ id: 'asset-1' })],
      },
      {
        item: { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1' } },
        jobs: [],
        stub: [AssetFactory.create({ id: 'asset-1', type: AssetType.Video })],
      },
      {
        item: { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1', source: 'upload' } },
        jobs: [JobName.SmartSearch, JobName.AssetDetectFaces, JobName.Ocr],
        stub: [AssetFactory.create({ id: 'asset-1', livePhotoVideoId: newUuid() })],
      },
      {
        item: { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1', source: 'upload' } },
        jobs: [JobName.SmartSearch, JobName.AssetDetectFaces, JobName.Ocr, JobName.AssetEncodeVideo],
        stub: [AssetFactory.create({ id: 'asset-1', type: AssetType.Video })],
      },
      {
        item: { name: JobName.SmartSearch, data: { id: 'asset-1' } },
        jobs: [],
      },
      {
        item: { name: JobName.AssetDetectFaces, data: { id: 'asset-1' } },
        jobs: [],
      },
      {
        item: { name: JobName.FacialRecognition, data: { id: 'asset-1' } },
        jobs: [],
      },
    ];

    for (const { item, jobs, stub } of tests) {
      it(`should queue ${jobs.length} jobs when a ${item.name} job finishes successfully`, async () => {
        if (stub) {
          mocks.asset.getById.mockResolvedValue(stub[0]);
          mocks.asset.getByIdsWithAllRelationsButStacks.mockResolvedValue(stub);
        }

        mocks.job.run.mockResolvedValue(JobStatus.Success);

        await sut.onJobRun(QueueName.BackgroundTask, item);

        if (jobs.length > 1) {
          expect(mocks.job.queueAll).toHaveBeenCalledWith(
            jobs.map((jobName) => ({ name: jobName, data: expect.anything() })),
          );
        } else {
          expect(mocks.job.queue).toHaveBeenCalledTimes(jobs.length);
          for (const jobName of jobs) {
            expect(mocks.job.queue).toHaveBeenCalledWith({ name: jobName, data: expect.anything() });
          }
        }
      });

      it(`should not queue any jobs when ${item.name} fails`, async () => {
        mocks.job.run.mockResolvedValue(JobStatus.Failed);

        await expect(sut.onJobRun(QueueName.BackgroundTask, item)).rejects.toThrow(`${item.name} failed`);

        expect(mocks.job.queueAll).not.toHaveBeenCalled();
      });
    }
  });
});
