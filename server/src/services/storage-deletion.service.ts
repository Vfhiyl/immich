import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { chunk, partition } from 'lodash-es';
import { DateTime } from 'luxon';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { mapNotification } from 'src/dtos/notification.dto.js';
import {
  StorageDeletionOriginalsQueryDto,
  StorageDeletionOriginalsResponseDto,
  StorageDeletionPurgeDto,
  StorageDeletionStatusResponseDto,
} from 'src/dtos/storage-deletion.dto.js';
import {
  CacheControl,
  ImmichWorker,
  JobName,
  JobStatus,
  NotificationLevel,
  NotificationType,
  QueueName,
  SystemMetadataKey,
} from 'src/enum.js';
import { toDeletedOriginalFile } from 'src/repositories/storage-deletion.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { StorageDeletionState } from 'src/types.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import { mimeTypes } from 'src/utils/mime-types.js';

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

const encodeCursor = ({ createdAt, id }: { createdAt: Date; id: string }) =>
  Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');

const decodeCursor = (cursor: string) => {
  const [createdAt, id] = Buffer.from(cursor, 'base64url').toString().split('|', 2);
  const date = new Date(createdAt);
  if (!id || Number.isNaN(date.getTime())) {
    throw new BadRequestException('Invalid cursor');
  }
  return { createdAt: date, id };
};

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
    // an administrator who resumed deleting approved what was due then
    const approved = state?.approvedDueOriginals ?? 0;
    if (dueOriginals > Math.max(limit, approved)) {
      await this.pause({ pausedAt: now.toISOString(), dueOriginals, limit });
      return JobStatus.Skipped;
    }
    if (approved > 0 && dueOriginals <= limit) {
      // back to usual amounts: the next unusual one needs an approval of its own
      await this.systemMetadataRepository.set(SystemMetadataKey.StorageDeletionState, {});
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

  async getStatus(): Promise<StorageDeletionStatusResponseDto> {
    const state = await this.systemMetadataRepository.get(SystemMetadataKey.StorageDeletionState);
    const pending = await this.storageDeletionRepository.countPending();
    return {
      isPaused: !!state?.pausedAt,
      pausedAt: state?.pausedAt,
      dueOriginals: state?.pausedAt ? state.dueOriginals : undefined,
      limit: state?.pausedAt ? state.limit : undefined,
      pendingOriginals: pending.originals,
      pendingFiles: pending.files,
      delayDays: this.storageBackendRepository.getOriginalsDeletionDelayDays(),
    };
  }

  /** Approve the deletion that paused deleting, and delete what is due */
  async resume(auth: AuthDto) {
    const state = await this.systemMetadataRepository.get(SystemMetadataKey.StorageDeletionState);
    if (!state?.pausedAt) {
      throw new BadRequestException('Deleting files from storage is not paused');
    }

    this.logger.warn(`Deleting ${state.dueOriginals} originals from storage was approved by ${auth.user.email}`);
    await this.systemMetadataRepository.set(SystemMetadataKey.StorageDeletionState, {
      approvedDueOriginals: state.dueOriginals,
    });
    await this.jobRepository.queue({ name: JobName.StorageDeletionRun });
  }

  async listOriginals({
    ownerId,
    cursor,
    limit = 100,
  }: StorageDeletionOriginalsQueryDto): Promise<StorageDeletionOriginalsResponseDto> {
    const rows = await this.storageDeletionRepository.listOriginals({
      ownerId,
      after: cursor ? decodeCursor(cursor) : undefined,
      limit: limit + 1,
    });
    const delayDays = this.storageBackendRepository.getOriginalsDeletionDelayDays();
    const items = rows.slice(0, limit).map((row) => {
      // a longer configured delay also applies to originals deleted before
      const byDelay = DateTime.fromJSDate(row.createdAt).plus({ days: delayDays });
      const deleteAfter = DateTime.max(byDelay, DateTime.fromJSDate(row.notBefore));
      return {
        id: row.id,
        ownerId: row.ownerId,
        originalFileName: row.originalFileName,
        fileCreatedAt: row.fileCreatedAt?.toISOString() ?? null,
        size: row.size === null ? null : Number(row.size),
        deletedAt: row.createdAt.toISOString(),
        deleteAfter: deleteAfter.toISO()!,
      };
    });
    const last = rows.length > limit ? rows[limit - 1] : undefined;
    return { items, nextCursor: last ? encodeCursor(last) : undefined };
  }

  /** The decrypted original, to look at before recovering or deleting it */
  async getOriginalFile(id: string): Promise<ImmichFileResponse> {
    const row = await this.getOriginal(id);
    return new ImmichFileResponse({
      ...this.storageBackendRepository.toFileSource(toDeletedOriginalFile(row)),
      fileName: row.originalFileName ?? row.key,
      contentType: mimeTypes.lookup(row.originalPath ?? row.originalFileName ?? ''),
      cacheControl: CacheControl.None,
    });
  }

  /** Delete an original from storage now, which cannot be undone, after the administrator confirmed their password */
  async purgeOriginal(auth: AuthDto, id: string, { password }: StorageDeletionPurgeDto) {
    const user = await this.userRepository.getForChangePassword(auth.user.id);
    if (!user.password || !this.cryptoRepository.compareBcrypt(password, user.password)) {
      throw new UnauthorizedException('Wrong password');
    }

    const row = await this.getOriginal(id);
    const recorded = await this.storageDeletionRepository.getRecorded([row]);
    if (recorded.length > 0) {
      throw new BadRequestException('The original is in use again');
    }

    const { failed } = await this.storageBackendRepository.getDeletionStore(row.backendId).deleteMany([row.key]);
    if (failed.length > 0) {
      throw new InternalServerErrorException('The storage backend did not delete the original');
    }
    await this.storageBackendRepository.dropLocalCopy(row);
    await this.storageDeletionRepository.remove([row.id]);
    this.logger.warn(
      `Deleted original ${row.backendId}:${row.key} (${row.originalFileName}) from storage early, by ${auth.user.email}`,
    );
  }

  async getOriginal(id: string) {
    const row = await this.storageDeletionRepository.get(id);
    if (!row?.isOriginal || row.originalFileName === null) {
      throw new NotFoundException('Deleted original not found');
    }
    return row;
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

  private async pause(state: Required<Pick<StorageDeletionState, 'pausedAt' | 'dueOriginals' | 'limit'>>) {
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
