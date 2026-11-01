import { getQueueToken } from '@nestjs/bullmq';
import { ModuleRef } from '@nestjs/core';
import { DelayedError, Job } from 'bullmq';
import { JobName, QueueName } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { BacklogJob, JobBacklogRepository } from 'src/repositories/job-backlog.repository.js';
import { JobFailureRepository } from 'src/repositories/job-failure.repository.js';
import { JOB_WINDOW, JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { JobItem } from 'src/types.js';
import { JobRetryLater } from 'src/utils/job-retry.js';
import { newJobFailureRepositoryMock } from 'test/repositories/job-failure.repository.mock.js';
import { automock } from 'test/utils.js';

const newQueue = (waiting = 0) => ({
  add: vi.fn().mockResolvedValue({}),
  addBulk: vi.fn().mockResolvedValue([]),
  drain: vi.fn().mockResolvedValue(undefined),
  getJobCounts: vi.fn().mockResolvedValue({ waiting, prioritized: 0, paused: 0, active: 0 }),
});

const setup = ({ waiting = 0, backlog = [] as BacklogJob[], events = {} as EventRepository } = {}) => {
  const queues = new Map<string, ReturnType<typeof newQueue>>();
  const queueOf = (name: QueueName) => {
    const token = getQueueToken(name);
    if (!queues.has(token)) {
      queues.set(token, newQueue(waiting));
    }
    return queues.get(token)!;
  };
  const moduleRef = {
    get: (token: string) => queueOf(Object.values(QueueName).find((name) => getQueueToken(name) === token)!),
  } as unknown as ModuleRef;
  const jobBacklog = automock(JobBacklogRepository, { strict: false });
  jobBacklog.add.mockResolvedValue();
  jobBacklog.count.mockResolvedValue(backlog.length);
  jobBacklog.has.mockResolvedValue(backlog.length > 0);
  jobBacklog.clear.mockResolvedValue();
  jobBacklog.take.mockImplementation(async (_queue, limit, use) => {
    const jobs = backlog.splice(0, limit);
    await use(jobs);
    return jobs.length;
  });
  const sut = new JobRepository(
    moduleRef,
    {} as ConfigRepository,
    events,
    LoggingRepository.create(),
    newJobFailureRepositoryMock() as unknown as JobFailureRepository,
    jobBacklog as unknown as JobBacklogRepository,
  );
  // the handlers of the jobs these tests queue, as setup() finds them in the services
  Object.assign(sut, {
    handlers: {
      [JobName.AssetGenerateThumbnails]: { queueName: QueueName.ThumbnailGeneration },
      [JobName.SmartSearch]: { queueName: QueueName.SmartSearch },
      [JobName.SmartSearchRebuild]: { queueName: QueueName.SmartSearch },
      [JobName.StorageTemplateMigrationSingle]: { queueName: QueueName.StorageTemplateMigration },
    },
  });
  return { sut, queueOf, jobBacklog };
};

const thumbnails = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    name: JobName.AssetGenerateThumbnails,
    data: { id: `asset-${index}` },
  })) as JobItem[];

// a job of the queue of videos whose run fails with `error`
const runFailing = (error: Error) => {
  const events = { emit: vi.fn().mockRejectedValue(error) } as unknown as EventRepository;
  const { sut } = setup({ events });
  const job = {
    data: { id: 'asset-1' },
    updateData: vi.fn().mockResolvedValue(undefined),
    moveToDelayed: vi.fn().mockResolvedValue(undefined),
  };
  return { job, result: sut['process'](QueueName.VideoConversion, job as unknown as Job, 'token') };
};

describe(JobRepository.name, () => {
  describe('process', () => {
    it('should put a job back for later, with what it keeps, so that the next job takes its place', async () => {
      const now = Date.now();
      const { job, result } = runFailing(
        new JobRetryLater('Waiting for memory', 60_000, { admissionWaitingSince: now }),
      );

      await expect(result).rejects.toBeInstanceOf(DelayedError);
      expect(job.updateData).toHaveBeenCalledWith({ id: 'asset-1', admissionWaitingSince: now });
      expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'token');
      expect(job.moveToDelayed.mock.calls[0][0]).toBeGreaterThanOrEqual(now + 60_000);
    });

    it('should let a job that fails fail', async () => {
      const error = new Error('cannot decode');
      const { job, result } = runFailing(error);

      await expect(result).rejects.toBe(error);
      expect(job.moveToDelayed).not.toHaveBeenCalled();
    });
  });

  describe('pausing a worker', () => {
    it('should take jobs again only once no reason to pause is left', async () => {
      const { sut } = setup();
      const worker = { isPaused: vi.fn().mockReturnValue(false), pause: vi.fn(), resume: vi.fn() };
      Object.assign(sut, { workers: { [QueueName.SmartSearch]: worker } });

      await sut.pauseWorker(QueueName.SmartSearch, 'backoff');
      await sut.pauseWorker(QueueName.SmartSearch, 'environment');
      worker.isPaused.mockReturnValue(true);
      sut.resumeWorker(QueueName.SmartSearch, 'backoff');
      expect(worker.resume).not.toHaveBeenCalled();

      sut.resumeWorker(QueueName.SmartSearch, 'environment');
      expect(worker.resume).toHaveBeenCalledOnce();
    });
  });

  describe('queueAll', () => {
    it('should give jobs queued in bulk their priority and delay', async () => {
      const { sut, queueOf } = setup();

      await sut.queueAll([
        { name: JobName.SmartSearch, data: { id: 'asset-1', priority: 10 } },
        { name: JobName.SmartSearchRebuild, data: { generation: 2, finish: true, priority: 30, delay: 60_000 } },
      ]);

      expect(queueOf(QueueName.SmartSearch).addBulk).toHaveBeenCalledWith([
        { name: JobName.SmartSearch, data: { id: 'asset-1', priority: 10 }, opts: { priority: 10 } },
        {
          name: JobName.SmartSearchRebuild,
          data: { generation: 2, finish: true, priority: 30, delay: 60_000 },
          opts: { priority: 30, delay: 60_000 },
        },
      ]);
    });

    it('should keep the jobs beyond the window of a queue in the backlog', async () => {
      const { sut, queueOf, jobBacklog } = setup({ waiting: JOB_WINDOW - 10 });

      await sut.queueAll(thumbnails(25));

      const [added] = queueOf(QueueName.ThumbnailGeneration).addBulk.mock.calls[0];
      expect(added).toHaveLength(10);
      expect(jobBacklog.add).toHaveBeenCalledWith(
        QueueName.ThumbnailGeneration,
        thumbnails(25)
          .slice(10)
          .map(({ name, data }) => ({ name, data, priority: 0 })),
      );
    });

    it('should not keep delayed jobs, or jobs with an id, in the backlog', async () => {
      const { sut, queueOf, jobBacklog } = setup({ waiting: JOB_WINDOW });

      await sut.queueAll([
        { name: JobName.SmartSearchRebuild, data: { generation: 2, finish: true, priority: 30, delay: 60_000 } },
        { name: JobName.StorageTemplateMigrationSingle, data: { id: 'asset-1' } },
      ]);

      expect(queueOf(QueueName.SmartSearch).addBulk).toHaveBeenCalledWith([
        expect.objectContaining({ name: JobName.SmartSearchRebuild }),
      ]);
      expect(queueOf(QueueName.StorageTemplateMigration).add).toHaveBeenCalled();
      expect(jobBacklog.add).toHaveBeenCalledWith(QueueName.SmartSearch, []);
    });
  });

  describe('refill', () => {
    it('should fill a queue that runs low up to its window, the jobs with their priority', async () => {
      const backlog = [
        { name: JobName.SmartSearch, data: { id: 'asset-1' }, priority: 0 },
        { name: JobName.SmartSearch, data: { id: 'asset-2' }, priority: 20 },
      ];
      const { sut, queueOf, jobBacklog } = setup({ waiting: JOB_WINDOW / 2 - 1, backlog });

      await expect(sut.refill(QueueName.SmartSearch)).resolves.toBe(2);

      expect(jobBacklog.take).toHaveBeenCalledWith(QueueName.SmartSearch, JOB_WINDOW / 2 + 1, expect.any(Function));
      expect(queueOf(QueueName.SmartSearch).addBulk).toHaveBeenCalledWith([
        { name: JobName.SmartSearch, data: { id: 'asset-1' }, opts: undefined },
        { name: JobName.SmartSearch, data: { id: 'asset-2' }, opts: { priority: 20 } },
      ]);
    });

    it('should leave a queue with half a window waiting', async () => {
      const backlog = [{ name: JobName.SmartSearch, data: { id: 'asset-1' }, priority: 0 }];
      const { sut, jobBacklog } = setup({ waiting: JOB_WINDOW / 2, backlog });

      await expect(sut.refill(QueueName.SmartSearch)).resolves.toBe(0);

      expect(jobBacklog.take).not.toHaveBeenCalled();
    });
  });

  it('should count the backlog as waiting, and empty it with the queue', async () => {
    const backlog = [{ name: JobName.SmartSearch, data: { id: 'asset-1' }, priority: 0 }];
    const { sut, queueOf, jobBacklog } = setup({ waiting: 3, backlog });

    await expect(sut.getJobCounts(QueueName.SmartSearch)).resolves.toMatchObject({ waiting: 4 });

    await sut.empty(QueueName.SmartSearch);
    expect(jobBacklog.clear).toHaveBeenCalledWith(QueueName.SmartSearch);
    expect(queueOf(QueueName.SmartSearch).drain).toHaveBeenCalled();
  });
});
