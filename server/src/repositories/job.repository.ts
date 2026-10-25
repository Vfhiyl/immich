import { getQueueToken } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import { JobsOptions, Queue, Worker } from 'bullmq';
import { setTimeout } from 'node:timers/promises';
import type { JobCounts, JobItem, JobOf } from 'src/types.js';
import { serverVersion } from 'src/constants.js';
import { JobConfig } from 'src/decorators.js';
import { QueueJobResponseDto, QueueJobSearchDto } from 'src/dtos/queue.dto.js';
import { ImmichWorker, JobName, JobStatus, MetadataKey, QueueCleanType, QueueJobStatus, QueueName } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobBacklogRepository } from 'src/repositories/job-backlog.repository.js';
import { JobFailureRepository } from 'src/repositories/job-failure.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { getTrackedAssetId } from 'src/utils/job-failure.js';
import { ImmichStartupError, getKeyByValue, getMethodNames } from 'src/utils/misc.js';
import { withStoragePurpose } from 'src/utils/storage-metering.js';

type JobMapItem = {
  jobName: JobName;
  queueName: QueueName;
  handler: (job: JobOf<any>) => Promise<JobStatus>;
  label: string;
};

const WORKER_WATCH_INTERVAL_MS = 30_000;

/**
 * How many jobs a queue keeps waiting in redis. The rest of a large batch (a job for every asset of the library, say)
 * waits in the database (`job_backlog`), and comes into the queue as it runs low: redis holds a window of each queue
 * instead of the whole library, in memory
 */
export const JOB_WINDOW = 200;

/** How often the queues are filled up from the backlog, besides as their jobs end */
const REFILL_INTERVAL_MS = 5000;

/** How often a queue is filled up at most as its jobs end */
const REFILL_THROTTLE_MS = 1000;

type QueuedJob = { name: JobName; data: unknown; opts: JobsOptions | undefined };

@Injectable()
export class JobRepository {
  private workers: Partial<Record<QueueName, Worker>> = {};
  private handlers: Partial<Record<JobName, JobMapItem>> = {};
  private workerWatcher?: ReturnType<typeof setInterval>;
  private microservicesPresent = true;
  private refillTimer?: ReturnType<typeof setInterval>;
  private refilledAt: Partial<Record<QueueName, number>> = {};
  private refilling = new Set<QueueName>();

  constructor(
    private moduleRef: ModuleRef,
    private configRepository: ConfigRepository,
    private eventRepository: EventRepository,
    private logger: LoggingRepository,
    private jobFailureRepository: JobFailureRepository,
    private jobBacklogRepository: JobBacklogRepository,
  ) {
    this.logger.setContext(JobRepository.name);
  }

  setup(services: (new (...args: any[]) => unknown)[]) {
    const reflector = this.moduleRef.get(Reflector, { strict: false });

    // discovery
    for (const Service of services) {
      const instance = this.moduleRef.get<any>(Service);
      for (const methodName of getMethodNames(instance)) {
        const handler = instance[methodName];
        const config = reflector.get<JobConfig>(MetadataKey.JobConfig, handler);
        if (!config) {
          continue;
        }

        const { name: jobName, queue: queueName } = config;
        const label = `${Service.name}.${handler.name}`;

        // one handler per job
        if (Object.hasOwn(this.handlers, jobName)) {
          const jobKey = getKeyByValue(JobName, jobName);
          const errorMessage = `Failed to add job handler for ${label}`;
          this.logger.error(
            `${errorMessage}. JobName.${jobKey} is already handled by ${this.handlers[jobName]!.label}.`,
          );
          throw new ImmichStartupError(errorMessage);
        }

        this.handlers[jobName] = {
          label,
          jobName,
          queueName,
          handler: handler.bind(instance),
        };

        this.logger.verbose(`Added job handler: ${jobName} => ${label}`);
      }
    }

    // no missing handlers
    for (const [jobKey, jobName] of Object.entries(JobName)) {
      const item = this.handlers[jobName];
      if (!item) {
        const errorMessage = `Failed to find job handler for Job.${jobKey} ("${jobName}")`;
        this.logger.error(
          `${errorMessage}. Make sure to add the @OnJob({ name: JobName.${jobKey}, queue: QueueName.XYZ }) decorator for the new job.`,
        );
        throw new ImmichStartupError(errorMessage);
      }
    }
  }

  startWorkers() {
    const { bull } = this.configRepository.getEnv();
    for (const queueName of Object.values(QueueName)) {
      this.logger.debug(`Starting worker for queue: ${queueName}`);
      const worker = new Worker(queueName, (job) => this.eventRepository.emit('JobRun', queueName, job as JobItem), {
        ...bull.config,
        concurrency: 1,
        name: ImmichWorker.Microservices,
      });
      // the queue may run low
      worker.on('completed', () => this.refillSoon(queueName));
      worker.on('failed', () => this.refillSoon(queueName));
      this.workers[queueName] = worker;
    }
    this.refillTimer ??= setInterval(() => void this.refillAll(), REFILL_INTERVAL_MS);
  }

  watchWorkers() {
    this.workerWatcher ??= setInterval(() => void this.checkWorkers(), WORKER_WATCH_INTERVAL_MS);
  }

  teardown() {
    clearInterval(this.refillTimer);
    this.refillTimer = undefined;
    if (!this.workerWatcher) {
      return;
    }

    clearInterval(this.workerWatcher);
    this.workerWatcher = undefined;
  }

  private async checkWorkers() {
    let isPresent: boolean;
    try {
      const suffix = `:w:${ImmichWorker.Microservices}`;
      const workers = await this.getQueue(QueueName.BackgroundTask).getWorkers();
      isPresent = workers.some((worker) => worker.rawname?.endsWith(suffix));
    } catch {
      return;
    }

    if (this.microservicesPresent !== isPresent) {
      if (isPresent) {
        this.logger.log('Microservices worker connected.');
      } else {
        this.logger.warn(
          'No microservices worker is connected. Background jobs will not be processed until one is running.',
        );
      }
    }
    this.microservicesPresent = isPresent;
  }

  async run({ name, data }: JobItem) {
    const item = this.handlers[name as JobName];
    if (!item) {
      this.logger.warn(`Skipping unknown job: "${name}"`);
      return JobStatus.Skipped;
    }

    // storage requests are counted for the job that makes them
    return withStoragePurpose(name, () => item.handler(data));
  }

  setConcurrency(queueName: QueueName, concurrency: number) {
    const worker = this.workers[queueName];
    if (!worker) {
      this.logger.warn(`Unable to set queue concurrency, worker not found: '${queueName}'`);
      return;
    }

    worker.concurrency = concurrency;
  }

  async isActive(name: QueueName): Promise<boolean> {
    const queue = this.getQueue(name);
    const count = await queue.getActiveCount();
    return count > 0;
  }

  /** Stops this process taking jobs of a queue (the queue itself, and other processes, go on) */
  async pauseWorker(queueName: QueueName) {
    const worker = this.workers[queueName];
    if (worker && !worker.isPaused()) {
      // the jobs that run finish on their own
      await worker.pause(true);
    }
  }

  resumeWorker(queueName: QueueName) {
    const worker = this.workers[queueName];
    if (worker?.isPaused()) {
      worker.resume();
    }
  }

  async isPaused(name: QueueName): Promise<boolean> {
    return this.getQueue(name).isPaused();
  }

  pause(name: QueueName) {
    return this.getQueue(name).pause();
  }

  resume(name: QueueName) {
    return this.getQueue(name).resume();
  }

  async empty(name: QueueName) {
    await this.jobBacklogRepository.clear(name);
    await this.getQueue(name).drain();
  }

  clear(name: QueueName, type: QueueCleanType) {
    return this.getQueue(name).clean(0, 1000, type);
  }

  async getJobCounts(name: QueueName): Promise<JobCounts> {
    const { prioritized = 0, ...counts } = await this.getQueue(name).getJobCounts(
      'active',
      'completed',
      'failed',
      'delayed',
      'waiting',
      'paused',
      'prioritized',
    );
    // jobs with a priority (those of a rebuild of a model) wait in a list of their own, and the rest of a large batch
    // in the database
    const backlog = await this.jobBacklogRepository.count(name);
    return { ...counts, waiting: (counts.waiting ?? 0) + prioritized + backlog } as unknown as JobCounts;
  }

  private getQueueName(name: JobName) {
    return (this.handlers[name] as JobMapItem).queueName;
  }

  async queueAll(items: JobItem[]): Promise<void> {
    items = await this.withoutHeldBack(items);
    if (items.length === 0) {
      return;
    }

    const promises = [];
    const itemsByQueue = {} as Record<string, QueuedJob[]>;
    for (const item of items) {
      const queueName = this.getQueueName(item.name);
      // addBulk() takes the options of a job as `opts`
      const job: QueuedJob = { name: item.name, data: item.data || {}, opts: this.getJobOptions(item) || undefined };

      if (job.opts?.jobId || job.opts?.deduplication) {
        // need to use add() instead of addBulk() for jobId/deduplication to take effect
        promises.push(this.getQueue(queueName).add(item.name, item.data, job.opts));
      } else {
        itemsByQueue[queueName] ||= [];
        itemsByQueue[queueName].push(job);
      }
    }

    for (const [queueName, jobs] of Object.entries(itemsByQueue)) {
      promises.push(this.addWithinWindow(queueName as QueueName, jobs));
    }

    await Promise.all(promises);
  }

  /** Adds jobs to a queue as far as its window has room; the rest waits in the backlog */
  private async addWithinWindow(queueName: QueueName, jobs: QueuedJob[]) {
    const room = Math.max(JOB_WINDOW - (await this.getWaiting(queueName)), 0);
    const now: QueuedJob[] = [];
    const later: QueuedJob[] = [];
    for (const job of jobs) {
      // a delayed job waits in redis anyway
      (now.length < room || job.opts?.delay ? now : later).push(job);
    }
    if (now.length > 0) {
      await this.getQueue(queueName).addBulk(now);
    }
    await this.jobBacklogRepository.add(
      queueName,
      later.map(({ name, data, opts }) => ({ name, data, priority: opts?.priority ?? 0 })),
    );
  }

  /** The jobs of a queue waiting in redis */
  private async getWaiting(queueName: QueueName) {
    const {
      waiting = 0,
      prioritized = 0,
      paused = 0,
    } = await this.getQueue(queueName).getJobCounts('waiting', 'prioritized', 'paused');
    return waiting + prioritized + paused;
  }

  /** Fills a queue up from the backlog once it has less than half a window waiting; returns how many came */
  async refill(queueName: QueueName): Promise<number> {
    if (this.refilling.has(queueName)) {
      return 0;
    }
    this.refilling.add(queueName);
    this.refilledAt[queueName] = Date.now();
    try {
      if (!(await this.jobBacklogRepository.has(queueName))) {
        return 0;
      }
      const waiting = await this.getWaiting(queueName);
      if (waiting >= JOB_WINDOW / 2) {
        return 0;
      }
      return await this.jobBacklogRepository.take(queueName, JOB_WINDOW - waiting, async (jobs) => {
        await this.getQueue(queueName).addBulk(
          jobs.map(({ name, data, priority }) => ({ name, data, opts: priority ? { priority } : undefined })),
        );
      });
    } finally {
      this.refilling.delete(queueName);
    }
  }

  private refillSoon(queueName: QueueName) {
    if (Date.now() - (this.refilledAt[queueName] ?? 0) < REFILL_THROTTLE_MS) {
      return;
    }
    this.refill(queueName).catch((error) => this.logger.warn(`Unable to fill up queue ${queueName}: ${error}`));
  }

  private async refillAll() {
    for (const queueName of Object.values(QueueName)) {
      try {
        await this.refill(queueName);
      } catch (error) {
        this.logger.warn(`Unable to fill up queue ${queueName}: ${error}`);
      }
    }
  }

  async queue(item: JobItem): Promise<void> {
    return this.queueAll([item]);
  }

  /** Leaves out the jobs for files they failed on again and again, until an admin retries them */
  private async withoutHeldBack(items: JobItem[]) {
    const byJob = new Map<JobName, string[]>();
    for (const item of items) {
      const assetId = getTrackedAssetId(item);
      if (!assetId) {
        continue;
      }
      const assetIds = byJob.get(item.name) ?? [];
      assetIds.push(assetId);
      byJob.set(item.name, assetIds);
    }
    const heldBack = new Set<string>();
    for (const [jobName, assetIds] of byJob) {
      for (const assetId of await this.jobFailureRepository.getHeldBack(jobName, assetIds, serverVersion.toString())) {
        heldBack.add(`${jobName}/${assetId}`);
      }
    }
    return heldBack.size === 0
      ? items
      : items.filter((item) => !heldBack.has(`${item.name}/${getTrackedAssetId(item)}`));
  }

  async waitForQueueCompletion(...queues: QueueName[]): Promise<void> {
    const getPending = async () => {
      const results = await Promise.all(queues.map(async (name) => ({ pending: await this.isActive(name), name })));
      return results.filter(({ pending }) => pending).map(({ name }) => name);
    };

    let pending = await getPending();

    while (pending.length > 0) {
      this.logger.verbose(`Waiting for ${pending[0]} queue to stop...`);
      await setTimeout(1000);
      pending = await getPending();
    }
  }

  async searchJobs(name: QueueName, dto: QueueJobSearchDto): Promise<QueueJobResponseDto[]> {
    const jobs = await this.getQueue(name).getJobs(dto.status ?? Object.values(QueueJobStatus), 0, 1000);
    return jobs.map((job) => {
      const { id, name, timestamp, data } = job;
      return { id, name: name as JobName, timestamp, data };
    });
  }

  private getJobOptions(item: JobItem): JobsOptions | null {
    switch (item.name) {
      // a failed job would keep its id, and a job with the same id would not be queued until it is cleared
      case JobName.NotifyAlbumUpdate: {
        return {
          jobId: `${item.data.id}/${item.data.recipientId}`,
          delay: item.data?.delay,
          removeOnFail: true,
        };
      }
      case JobName.StorageTemplateMigrationSingle: {
        return { jobId: item.data.id, removeOnFail: true };
      }
      case JobName.PersonGenerateThumbnail: {
        return { priority: 1 };
      }
      case JobName.SmartSearch:
      case JobName.AssetDetectFaces:
      case JobName.Ocr: {
        return item.data.priority ? { priority: item.data.priority } : null;
      }
      case JobName.SmartSearchRebuild:
      case JobName.FaceDetectionRebuild:
      case JobName.OcrRebuild: {
        return { priority: item.data.priority, delay: item.data.delay };
      }
      case JobName.FacialRecognitionQueueAll: {
        return { deduplication: { id: JobName.FacialRecognitionQueueAll } };
      }
      case JobName.VersionCheck: {
        return { deduplication: { id: JobName.VersionCheck } };
      }
      case JobName.DatabaseBackup: {
        return { deduplication: { id: JobName.DatabaseBackup } };
      }
      // one run copies everything that is due, and runs are queued every few minutes
      case JobName.StorageReplicate: {
        return { deduplication: { id: JobName.StorageReplicate } };
      }
      default: {
        return null;
      }
    }
  }

  private getQueue(queue: QueueName): Queue {
    return this.moduleRef.get<Queue>(getQueueToken(queue), { strict: false });
  }

  /** @deprecated */
  // todo: remove this when asset notifications no longer need it.
  public async removeJob(name: JobName, jobID: string): Promise<void> {
    const existingJob = await this.getQueue(this.getQueueName(name)).getJob(jobID);
    if (existingJob) {
      await existingJob.remove();
    }
  }
}
