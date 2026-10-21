import { Injectable } from '@nestjs/common';
import { chunk, partition } from 'lodash-es';
import { OnEvent, OnJob } from 'src/decorators.js';
import { mapNotification } from 'src/dtos/notification.dto.js';
import {
  ImmichWorker,
  JobName,
  JobStatus,
  NotificationLevel,
  NotificationType,
  QueueName,
  SystemMetadataKey,
} from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { StorageDeletionState } from 'src/types.js';

/** Deletions are read and deleted in batches of this size */
const DELETION_BATCH_SIZE = 1000;
/** A run stops after this many files; the rest waits for the next run */
const DELETIONS_PER_RUN = 100_000;
/**
 * A run that would delete more originals than this share of all of them (and at least the minimum) pauses instead, and
 * an administrator decides: deleting that much at once is more likely a mistake than what anyone wanted.
 */
const PAUSE_SHARE = 0.02;
const PAUSE_MINIMUM = 100;

/** Deletes files on storage backends once their deletion delay has passed */
@Injectable()
export class StorageDeletionService extends BaseService {
  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  async onBootstrap() {
    await this.jobRepository.queue({ name: JobName.StorageDeletionRun });
  }

  @OnJob({ name: JobName.StorageDeletionRun, queue: QueueName.BackgroundTask })
  async handleStorageDeletionRun(): Promise<JobStatus> {
    const state = await this.systemMetadataRepository.get(SystemMetadataKey.StorageDeletionState);
    if (state?.pausedAt) {
      this.logger.warn(`Deleting files from storage backends is paused since ${state.pausedAt}`);
      return JobStatus.Skipped;
    }

    const now = new Date();
    const originalsDelayDays = this.storageBackendRepository.getOriginalsDeletionDelayDays();
    const dueOriginals = await this.storageDeletionRepository.countDueOriginals({ now, originalsDelayDays });
    const stored = await this.storageDeletionRepository.countStoredOriginals();
    const limit = Math.max(PAUSE_MINIMUM, Math.ceil((stored + dueOriginals) * PAUSE_SHARE));
    if (dueOriginals > limit) {
      await this.pause({ pausedAt: now.toISOString(), dueOriginals, limit });
      return JobStatus.Skipped;
    }

    let processed = 0;
    while (processed < DELETIONS_PER_RUN) {
      const due = await this.storageDeletionRepository.getDue({ now, originalsDelayDays, limit: DELETION_BATCH_SIZE });
      if (due.length === 0) {
        break;
      }
      // every file of a batch is deleted, dropped or postponed, so the next batch holds other files
      await this.deleteBatch(due, now);
      processed += due.length;
    }

    return JobStatus.Success;
  }

  private async deleteBatch(due: Array<{ id: string; backendId: string; key: string }>, now: Date) {
    const recordedFiles = await this.storageDeletionRepository.getRecorded(due);
    const recorded = new Set(recordedFiles.map(({ backendId, key }) => `${backendId}:${key}`));
    const [stale, deletable] = partition(due, ({ backendId, key }) => recorded.has(`${backendId}:${key}`));
    for (const { backendId, key } of stale) {
      this.logger.warn(`Not deleting ${backendId}:${key}, which is recorded again`);
    }
    await this.storageDeletionRepository.remove(stale.map(({ id }) => id));

    for (const [backendId, files] of Map.groupBy(deletable, ({ backendId }) => backendId)) {
      try {
        const store = this.storageBackendRepository.getDeletionStore(backendId);
        for (const batch of chunk(files, store.limits.maxDeleteBatch)) {
          const { failed } = await store.deleteMany(batch.map(({ key }) => key));
          const isFailed = new Set(failed);
          const [notDeleted, deleted] = partition(batch, ({ key }) => isFailed.has(key));
          for (const file of deleted) {
            await this.storageBackendRepository.dropLocalCopy(file);
          }
          // the registration goes only once the file is gone
          await this.storageDeletionRepository.remove(deleted.map(({ id }) => id));
          await this.storageDeletionRepository.recordFailure(
            notDeleted.map(({ id }) => id),
            'The storage backend did not delete the file',
            now,
          );
        }
      } catch (error) {
        this.logger.warn(`Unable to delete files from storage backend ${backendId}: ${error}`);
        await this.storageDeletionRepository.recordFailure(
          files.map(({ id }) => id),
          String(error),
          now,
        );
      }
    }
  }

  private async pause(state: Required<StorageDeletionState>) {
    await this.systemMetadataRepository.set(SystemMetadataKey.StorageDeletionState, state);
    const message =
      `${state.dueOriginals} deleted originals are due to be deleted from storage, more than the ${state.limit} ` +
      'that are deleted without asking. Deleting files from storage is paused until an administrator resumes it.';
    this.logger.warn(message);

    const admin = await this.userRepository.getAdmin();
    if (!admin) {
      return;
    }
    const notification = await this.notificationRepository.create({
      userId: admin.id,
      type: NotificationType.SystemMessage,
      level: NotificationLevel.Error,
      title: 'Deleting files from storage is paused',
      description: message,
    });
    this.websocketRepository.clientSend('on_notification', admin.id, mapNotification(notification));
  }
}
