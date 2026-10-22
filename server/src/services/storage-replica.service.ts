import { BadRequestException, Injectable } from '@nestjs/common';
import { chunk } from 'lodash-es';
import { OnEvent, OnJob } from 'src/decorators.js';
import { mapNotification } from 'src/dtos/notification.dto.js';
import { StorageReplicaFailingResponseDto, StorageReplicaListResponseDto } from 'src/dtos/storage-replica.dto.js';
import {
  DatabaseLock,
  ImmichWorker,
  JobName,
  JobStatus,
  NotificationLevel,
  NotificationType,
  QueueName,
  StorageCheckKind,
} from 'src/enum.js';
import { BlobExistsError } from 'src/repositories/blob-store.js';
import {
  FAILING_COPY_ATTEMPTS,
  ReplicaCopy,
  TRACKED_REPLICA_ROLES,
} from 'src/repositories/storage-replica.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { handlePromiseError } from 'src/utils/misc.js';

/** Copies are made every few minutes, so that the newest files are at most that much older on the replicas */
const REPLICATE_CRON = '*/5 * * * *';
/** A run stops taking copies after this long, and the next run continues */
const REPLICATE_RUN_MS = 15 * 60 * 1000;
/** Copies taken at once, and made at the same time */
const COPY_BATCH_SIZE = 16;
const COPY_CONCURRENCY = 4;
/** How long a worker holds the copies it took; a copy that was not made by then is taken again */
const COPY_LEASE_MS = 60 * 60 * 1000;

/**
 * Copies of files on replicas. A copy of every original is registered with it (by a trigger, in the same transaction),
 * and made in the background: the bytes as they are stored, still encrypted, to the folder the replica keeps the
 * backend in, under the same key. A copy counts as made once the replica returned the size of the original. Copies are
 * only read when a backend is lost, by configuring the backend with the folder of a replica.
 */
@Injectable()
export class StorageReplicaService extends BaseService {
  private replicationLock = false;

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  async onBootstrap() {
    const sources = this.getTrackedSources();
    const added = await this.storageReplicaRepository.setSources(sources);
    for (const { replicaBackendId, sourceBackendId } of added) {
      this.logger.log(`Storage backend ${replicaBackendId} is a new replica of ${sourceBackendId}`);
    }
    if (added.length > 0) {
      // copies of what is stored already are registered by a reconciliation
      await this.jobRepository.queue({ name: JobName.StorageReplicaReconcile, data: { force: true } });
    }
    if (sources.length > 0) {
      await this.jobRepository.queue({ name: JobName.StorageReplicate });
    }
  }

  @OnEvent({ name: 'ConfigInit', workers: [ImmichWorker.Microservices] })
  async onConfigInit() {
    if (this.storageBackendRepository.getReplicaSources().length === 0) {
      return;
    }
    this.replicationLock = await this.databaseRepository.tryLock(DatabaseLock.StorageReplication);
    if (!this.replicationLock) {
      return;
    }
    this.cronRepository.create({
      name: 'storageReplicate',
      expression: REPLICATE_CRON,
      onTick: () => handlePromiseError(this.jobRepository.queue({ name: JobName.StorageReplicate }), this.logger),
      start: true,
    });
  }

  /** New originals are copied right away; what the runs every few minutes miss is copied by the next one */
  @OnEvent({ name: 'AssetCreate' })
  onAssetCreate() {
    return this.queueReplicate();
  }

  /** Extracting metadata stores the videos of motion photos as originals of their own */
  @OnEvent({ name: 'AssetMetadataExtracted' })
  onAssetMetadataExtracted() {
    return this.queueReplicate();
  }

  private async queueReplicate() {
    if (this.getTrackedSources().length > 0) {
      await this.jobRepository.queue({ name: JobName.StorageReplicate });
    }
  }

  @OnJob({ name: JobName.StorageReplicate, queue: QueueName.BackgroundTask })
  async handleReplicate(): Promise<JobStatus> {
    if (this.getTrackedSources().length === 0) {
      return JobStatus.Skipped;
    }

    const deadline = Date.now() + REPLICATE_RUN_MS;
    let failing = 0;
    while (Date.now() < deadline) {
      const copies = await this.storageReplicaRepository.claim({
        now: new Date(),
        limit: COPY_BATCH_SIZE,
        leaseMs: COPY_LEASE_MS,
      });
      if (copies.length === 0) {
        break;
      }
      for (const group of chunk(copies, COPY_CONCURRENCY)) {
        const results = await Promise.all(group.map((copy) => this.makeCopy(copy)));
        failing += results.filter((result) => result === 'now-failing').length;
      }
    }

    if (failing > 0) {
      await this.notifyAdmin(failing);
    }
    return JobStatus.Success;
  }

  async getReplicas(): Promise<StorageReplicaListResponseDto> {
    const [statuses, lastReconcile, lastVerify] = await Promise.all([
      this.storageReplicaRepository.getStatus(),
      this.storageCheckRepository.getLastRun(StorageCheckKind.ReplicaReconcile),
      this.storageCheckRepository.getLastRun(StorageCheckKind.ReplicaVerify),
    ]);
    const sources = this.storageBackendRepository.getReplicaSources();
    const replicas = [];
    for (const [replicaBackendId, ofReplica] of Map.groupBy(sources, ({ replicaBackendId }) => replicaBackendId)) {
      const status = statuses.find((status) => status.replicaBackendId === replicaBackendId);
      let sourceFiles = 0;
      for (const { sourceBackendId, role } of ofReplica) {
        if (TRACKED_REPLICA_ROLES.has(role)) {
          sourceFiles += await this.storageReplicaRepository.countSourceFiles(sourceBackendId);
        }
      }
      replicas.push({
        id: replicaBackendId,
        replicaOf: ofReplica.map(({ role }) => role),
        sourceFiles,
        copied: status?.copied ?? 0,
        copiedBytes: status?.copiedBytes ?? 0,
        pending: status?.pending ?? 0,
        failing: status?.failing ?? 0,
        oldestPendingAt: status?.oldestPendingAt ? new Date(status.oldestPendingAt).toISOString() : null,
      });
    }
    return {
      replicas,
      lastReconcileAt: lastReconcile ? new Date(lastReconcile.startedAt).toISOString() : null,
      lastVerifyAt: lastVerify ? new Date(lastVerify.startedAt).toISOString() : null,
    };
  }

  async getFailing(replicaBackendId: string): Promise<StorageReplicaFailingResponseDto> {
    this.requireReplica(replicaBackendId);
    const rows = await this.storageReplicaRepository.getFailing(replicaBackendId, 100);
    return {
      items: rows.map((row) => ({
        backendId: row.sourceBackendId,
        key: row.key,
        attempts: row.attempts,
        lastError: row.lastError,
        nextAttemptAt: new Date(row.nextAttemptAt).toISOString(),
        registeredAt: new Date(row.createdAt).toISOString(),
      })),
    };
  }

  /** Try the copies to a replica that failed again now, e.g. after fixing what made them fail */
  async retryFailed(replicaBackendId: string) {
    this.requireReplica(replicaBackendId);
    const count = await this.storageReplicaRepository.retryFailed(replicaBackendId, new Date());
    await this.jobRepository.queue({ name: JobName.StorageReplicate });
    return { count };
  }

  private requireReplica(replicaBackendId: string) {
    const isReplica = this.storageBackendRepository
      .getReplicaSources()
      .some((source) => source.replicaBackendId === replicaBackendId);
    if (!isReplica) {
      throw new BadRequestException(`Storage backend ${replicaBackendId} is not a replica`);
    }
  }

  private getTrackedSources() {
    return this.storageBackendRepository
      .getReplicaSources()
      .filter(({ role }) => TRACKED_REPLICA_ROLES.has(role))
      .map(({ replicaBackendId, sourceBackendId }) => ({ replicaBackendId, sourceBackendId }));
  }

  /** Copy a file as it is stored, and record the copy once the replica has all of it */
  private async makeCopy(copy: ReplicaCopy): Promise<'copied' | 'failed' | 'now-failing'> {
    const { id, replicaBackendId, sourceBackendId, key } = copy;
    try {
      const source = this.storageBackendRepository.get(sourceBackendId);
      const stat = await source.head(key);
      if (!stat) {
        // which does not prove that it is gone: it is tried again later
        throw new Error(`${sourceBackendId}:${key} was not found`);
      }

      const replica = this.storageBackendRepository.getReplicaStore(replicaBackendId, sourceBackendId);
      try {
        await replica.put(key, await source.get(key, { expect: { size: stat.size } }), { sizeHint: stat.size });
      } catch (error) {
        // made before, without being recorded: the size check below tells whether it is complete
        if (!(error instanceof BlobExistsError)) {
          throw error;
        }
      }

      const copied = await replica.head(key);
      if (copied?.size !== stat.size) {
        throw new Error(`The replica holds ${copied ? copied.size : 'no'} bytes of ${stat.size}`);
      }

      if (!(await this.storageReplicaRepository.complete(id, stat.size, new Date()))) {
        // the file was deleted while it was copied, and its copies with it: this one goes too
        await this.storageBackendRepository
          .getReplicaStore(replicaBackendId, sourceBackendId, { deletion: true })
          .deleteMany([key]);
      }
      return 'copied';
    } catch (error) {
      this.logger.warn(`Unable to copy ${sourceBackendId}:${key} to replica ${replicaBackendId}: ${error}`);
      await this.storageReplicaRepository.recordFailure(id, String(error), new Date());
      return copy.attempts + 1 === FAILING_COPY_ATTEMPTS ? 'now-failing' : 'failed';
    }
  }

  private async notifyAdmin(failing: number) {
    const admin = await this.userRepository.getAdmin();
    if (!admin) {
      return;
    }
    const notification = await this.notificationRepository.create({
      userId: admin.id,
      type: NotificationType.SystemMessage,
      level: NotificationLevel.Error,
      title: 'Copying files to replicas keeps failing',
      description: `${failing} more files could not be copied to a replica after ${FAILING_COPY_ATTEMPTS} attempts. They are tried again later; see the replicas page.`,
    });
    this.websocketRepository.clientSend('on_notification', admin.id, mapNotification(notification));
  }
}
