import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DateTime } from 'luxon';
import { createReadStream } from 'node:fs';
import type { IStorageCheckJob } from 'src/types.js';
import { OnJob } from 'src/decorators.js';
import { mapNotification } from 'src/dtos/notification.dto.js';
import {
  StorageCheckRunDto,
  StorageCheckRunsQueryDto,
  StorageCheckStartDto,
  StorageCheckSummaryResponseDto,
  StorageIssueDto,
  StorageIssuesQueryDto,
  StorageIssuesResponseDto,
} from 'src/dtos/storage-check.dto.js';
import {
  JobName,
  JobStatus,
  NotificationLevel,
  NotificationType,
  QueueName,
  StorageBackendRole,
  StorageCheckKind,
  StorageCheckStatus,
  StorageIssueKind,
} from 'src/enum.js';
import { BlobIntegrityError, createVerifyingStream } from 'src/repositories/blob-store.js';
import { readBlob } from 'src/repositories/storage-backend.repository.js';
import { FoundIssue, ListedBlob, VerifiableFile } from 'src/repositories/storage-check.repository.js';
import { StorageCheckStats } from 'src/schema/tables/storage-check.table.js';
import { BaseService } from 'src/services/base.service.js';

/**
 * What is younger is not judged: a service may list a new object late (it only promises eventual consistency), and a
 * file may be written moments before it is recorded
 */
export const STORAGE_CHECK_GRACE_MS = 48 * 60 * 60 * 1000;
/**
 * Reconciliation runs at most this often: the checks for missing and for untracked files both start one, and two runs
 * a moment apart would see each other's issues as a second look
 */
const RECONCILE_MIN_INTERVAL_MS = 60 * 60 * 1000;
const LISTING_BATCH_SIZE = 1000;
/** New files are read back a day after they were written, which was verified then */
const NEW_FILE_DELAY_MS = 24 * 60 * 60 * 1000;

/** Reports are kept for three years */
const REPORT_RETENTION_YEARS = 3;

type Run = NonNullable<Awaited<ReturnType<BaseService['storageCheckRepository']['getRun']>>>;
type Issue = Awaited<ReturnType<BaseService['storageCheckRepository']['getIssues']>>[number];

const mapRun = ({ id, kind, status, startedAt, finishedAt, stats }: Run): StorageCheckRunDto => ({
  id,
  kind,
  status,
  startedAt: new Date(startedAt).toISOString(),
  finishedAt: finishedAt ? new Date(finishedAt).toISOString() : null,
  ...stats,
});

const toIso = (value: Date | string | null) => (value ? new Date(value).toISOString() : null);

const mapIssue = (issue: Issue): StorageIssueDto => ({
  id: issue.id,
  backendId: issue.backendId,
  key: issue.key,
  kind: issue.kind,
  detail: issue.detail,
  firstSeenAt: toIso(issue.firstSeenAt)!,
  lastSeenAt: toIso(issue.lastSeenAt)!,
  confirmedAt: toIso(issue.confirmedAt)!,
  resolvedAt: toIso(issue.resolvedAt),
  acknowledgedAt: toIso(issue.acknowledgedAt),
});

const encodeIssueCursor = ({ lastSeenAt, id }: Issue) =>
  Buffer.from(`${new Date(lastSeenAt).toISOString()}|${id}`).toString('base64url');

const decodeIssueCursor = (cursor: string) => {
  const [lastSeenAt, id] = Buffer.from(cursor, 'base64url').toString().split('|', 2);
  const date = new Date(lastSeenAt);
  if (!id || Number.isNaN(date.getTime())) {
    throw new BadRequestException('Invalid cursor');
  }
  return { lastSeenAt: date, id };
};

const csvValue = (value: string | null) => (value === null ? '' : `"${value.replaceAll('"', '""')}"`);

/** Backends whose files are recorded; backups describe themselves and are checked when they are stored */
const CHECKED_ROLES = new Set([StorageBackendRole.Originals, StorageBackendRole.Derived]);

/**
 * Checks of the files on storage backends, which report and never change anything. Reconciliation lists every backend
 * and compares it with what is recorded: files that are missing, that nothing records, or that have another size.
 */
@Injectable()
export class StorageCheckService extends BaseService {
  @OnJob({ name: JobName.StorageReconcile, queue: QueueName.IntegrityCheck })
  async handleReconcile({ force }: IStorageCheckJob = {}): Promise<JobStatus> {
    const backends = this.getCheckedBackends();
    if (backends.length === 0) {
      return JobStatus.Skipped;
    }

    const last = await this.storageCheckRepository.getLastRun(StorageCheckKind.Reconcile);
    if (!force && last && Date.now() - new Date(last.startedAt).getTime() < RECONCILE_MIN_INTERVAL_MS) {
      this.logger.debug('Skipping the reconciliation of storage backends, which ran recently');
      return JobStatus.Skipped;
    }

    const run = await this.storageCheckRepository.startRun(StorageCheckKind.Reconcile, backends);
    const now = new Date();
    const stats: StorageCheckStats = { backends, checked: 0, bytes: 0, newIssues: 0, openIssues: 0 };
    try {
      for (const backendId of backends) {
        await this.reconcileBackend(backendId, now, stats);
      }
    } catch (error) {
      this.logger.error(`Reconciliation of storage backends failed: ${error}`);
      await this.storageCheckRepository.finishRun(run.id, StorageCheckStatus.Failed, {
        ...stats,
        stoppedBecause: String(error),
      });
      throw error;
    }

    await this.finish(run.id, stats);
    await this.storageCheckRepository.removeOldReports(
      DateTime.now().minus({ years: REPORT_RETENTION_YEARS }).toJSDate(),
    );
    return JobStatus.Success;
  }

  /**
   * Read files back, decrypt them and compare their checksum, within the time and share of files the integrity check
   * settings allow per run: files that failed first, then files never verified, then the ones verified longest ago,
   * so that every file is read back in turn. New files wait a day, since they were verified when they were written.
   */
  @OnJob({ name: JobName.StorageVerify, queue: QueueName.IntegrityCheck })
  async handleVerify(): Promise<JobStatus> {
    const backends = this.getCheckedBackends();
    if (backends.length === 0) {
      return JobStatus.Skipped;
    }

    const {
      integrityChecks: { checksumFiles },
    } = await this.getConfig({ withCache: false });
    const run = await this.storageCheckRepository.startRun(StorageCheckKind.Verify, backends);
    const startedAt = new Date();
    const recordedBefore = new Date(startedAt.getTime() - NEW_FILE_DELAY_MS);
    const deadline = startedAt.getTime() + checksumFiles.timeLimit;
    const total = await this.storageCheckRepository.countVerifiable(backends, recordedBefore);
    const limit = Math.ceil(total * checksumFiles.percentageLimit);
    const stats: StorageCheckStats = { backends, checked: 0, bytes: 0, newIssues: 0, openIssues: 0 };

    try {
      verifying: while (stats.checked < limit) {
        const files = await this.getNextToVerify(
          backends,
          startedAt,
          recordedBefore,
          Math.min(100, limit - stats.checked),
        );
        if (files.length === 0) {
          break;
        }
        for (const file of files) {
          if (Date.now() >= deadline) {
            stats.stoppedBecause = 'time limit';
            break verifying;
          }
          await this.verifyFile(file, stats);
        }
      }
    } catch (error) {
      this.logger.error(`Verification of stored files failed: ${error}`);
      await this.storageCheckRepository.finishRun(run.id, StorageCheckStatus.Failed, {
        ...stats,
        stoppedBecause: String(error),
      });
      throw error;
    }

    await this.finish(run.id, stats);
    return JobStatus.Success;
  }

  async getSummary(): Promise<StorageCheckSummaryResponseDto> {
    const [lastReconcile, lastVerify] = await Promise.all([
      this.storageCheckRepository.getLastRun(StorageCheckKind.Reconcile),
      this.storageCheckRepository.getLastRun(StorageCheckKind.Verify),
    ]);
    const since = DateTime.now().startOf('month').minus({ months: 11 }).toJSDate();
    return {
      openIssues: await this.storageCheckRepository.countOpenIssuesByKind(),
      lastReconcile: lastReconcile ? mapRun(lastReconcile) : null,
      lastVerify: lastVerify ? mapRun(lastVerify) : null,
      months: await this.storageCheckRepository.getMonthlySummary(since),
    };
  }

  async getRuns({ kind, before, limit = 50 }: StorageCheckRunsQueryDto): Promise<StorageCheckRunDto[]> {
    const runs = await this.storageCheckRepository.getRuns({
      kind,
      before: before ? new Date(before) : undefined,
      limit,
    });
    return runs.map((run) => mapRun(run));
  }

  async getIssues({
    status,
    kind,
    backendId,
    cursor,
    limit = 100,
  }: StorageIssuesQueryDto): Promise<StorageIssuesResponseDto> {
    const rows = await this.storageCheckRepository.getIssues({
      status,
      kind,
      backendId,
      after: cursor ? decodeIssueCursor(cursor) : undefined,
      limit: limit + 1,
    });
    const items = rows.slice(0, limit).map((issue) => mapIssue(issue));
    const last = rows.length > limit ? rows[limit - 1] : undefined;
    return { items, nextCursor: last ? encodeIssueCursor(last) : undefined };
  }

  /** All reported issues as CSV, for keeping or sending elsewhere */
  async *getIssuesCsv(status: StorageIssuesQueryDto['status'] = 'all'): AsyncGenerator<string> {
    yield 'id,backendId,key,kind,detail,firstSeenAt,lastSeenAt,confirmedAt,resolvedAt,acknowledgedAt\n';
    let cursor: string | undefined;
    do {
      const page = await this.getIssues({ status, cursor, limit: 1000 });
      for (const issue of page.items) {
        yield [
          issue.id,
          issue.backendId,
          issue.key,
          issue.kind,
          issue.detail,
          issue.firstSeenAt,
          issue.lastSeenAt,
          issue.confirmedAt,
          issue.resolvedAt,
          issue.acknowledgedAt,
        ]
          .map((value) => csvValue(value))
          .join(',')
          .concat('\n');
      }
      cursor = page.nextCursor;
    } while (cursor);
  }

  async acknowledgeIssue(id: string) {
    if (!(await this.storageCheckRepository.acknowledgeIssue(id))) {
      throw new NotFoundException('Storage issue not found');
    }
  }

  /** Run a check now, e.g. after fixing what one reported */
  async startCheck({ kind }: StorageCheckStartDto) {
    if (this.getCheckedBackends().length === 0) {
      throw new BadRequestException('No storage backends to check are configured');
    }
    await this.jobRepository.queue(
      kind === StorageCheckKind.Reconcile
        ? { name: JobName.StorageReconcile, data: { force: true } }
        : { name: JobName.StorageVerify, data: { force: true } },
    );
  }

  private getCheckedBackends() {
    return this.storageBackendRepository
      .getConfiguredBackends()
      .filter(({ role }) => CHECKED_ROLES.has(role))
      .map(({ id }) => id);
  }

  private async getNextToVerify(
    backends: string[],
    startedAt: Date,
    recordedBefore: Date,
    limit: number,
  ): Promise<VerifiableFile[]> {
    const failed = await this.storageCheckRepository.getFailedVerifications(backends, startedAt, limit);
    if (failed.length > 0) {
      return this.withRecorded(failed, () => this.getNextToVerify(backends, startedAt, recordedBefore, limit));
    }
    const unverified = await this.storageCheckRepository.getUnverified(backends, recordedBefore, limit);
    if (unverified.length > 0) {
      return unverified;
    }
    const oldest = await this.storageCheckRepository.getOldestVerified(backends, startedAt, limit);
    return this.withRecorded(oldest, () => this.getNextToVerify(backends, startedAt, recordedBefore, limit));
  }

  /** What is recorded about verified files; ones that are no longer recorded are forgotten */
  private async withRecorded(rows: Array<{ backendId: string; key: string }>, next: () => Promise<VerifiableFile[]>) {
    const files: VerifiableFile[] = [];
    for (const [backendId, group] of Map.groupBy(rows, ({ backendId }) => backendId)) {
      const keys = group.map(({ key }) => key);
      const recorded = await this.storageCheckRepository.getRecordedFiles(backendId, keys);
      const recordedKeys = new Set(recorded.map(({ key }) => key));
      await this.storageCheckRepository.removeVerifications(
        backendId,
        keys.filter((key) => !recordedKeys.has(key)),
      );
      files.push(...recorded);
    }
    // all of these were forgotten, which leaves fewer to look at
    return files.length === 0 && rows.length > 0 ? next() : files;
  }

  private async verifyFile(file: VerifiableFile, stats: StorageCheckStats) {
    const { backendId, key } = file;
    const now = new Date();
    try {
      const recorded = { path: key, ...file };
      const source = this.storageBackendRepository.resolve(recorded);
      const content =
        'path' in source
          ? createReadStream(source.path).pipe(
              createVerifyingStream(key, { length: file.size ?? undefined, sha1: file.checksum ?? undefined }),
            )
          : await readBlob(source.blob);
      for await (const chunk of content as AsyncIterable<Buffer>) {
        stats.bytes += chunk.length;
      }
      stats.checked++;
      await this.storageCheckRepository.recordVerification(backendId, key, true, now);
      await this.storageCheckRepository.resolveIssues(backendId, key, [
        StorageIssueKind.Corrupt,
        StorageIssueKind.Unreadable,
      ]);
    } catch (error) {
      stats.checked++;
      const kind = error instanceof BlobIntegrityError ? StorageIssueKind.Corrupt : StorageIssueKind.Unreadable;
      this.logger.warn(`Verifying ${backendId}:${key} failed: ${error}`);
      await this.storageCheckRepository.recordVerification(backendId, key, false, now);
      stats.newIssues += await this.storageCheckRepository.recordSightings(
        backendId,
        kind,
        [{ key, detail: error instanceof Error ? error.message : String(error) }],
        now,
      );
    }
  }

  private async reconcileBackend(backendId: string, now: Date, stats: StorageCheckStats) {
    const before = new Date(now.getTime() - STORAGE_CHECK_GRACE_MS);
    await this.storageCheckRepository.clearListing(backendId);
    try {
      let batch: ListedBlob[] = [];
      for await (const entry of this.storageBackendRepository.get(backendId).list()) {
        batch.push(entry);
        stats.checked++;
        stats.bytes += entry.size;
        if (batch.length < LISTING_BATCH_SIZE) {
          continue;
        }

        await this.storageCheckRepository.addToListing(backendId, batch);
        batch = [];
      }
      await this.storageCheckRepository.addToListing(backendId, batch);

      const found: Array<[StorageIssueKind, FoundIssue[]]> = [
        [StorageIssueKind.Missing, await this.storageCheckRepository.findMissing(backendId, before)],
        [StorageIssueKind.SizeMismatch, await this.storageCheckRepository.findSizeMismatches(backendId)],
        [StorageIssueKind.Untracked, await this.storageCheckRepository.findUntracked(backendId, before)],
      ];
      for (const [kind, issues] of found) {
        stats.newIssues += await this.storageCheckRepository.recordSightings(backendId, kind, issues, now);
      }
      await this.storageCheckRepository.resolveUnseen(
        backendId,
        found.map(([kind]) => kind),
        now,
      );
    } finally {
      await this.storageCheckRepository.clearListing(backendId);
    }
  }

  private async finish(runId: string, stats: StorageCheckStats) {
    stats.openIssues = await this.storageCheckRepository.countOpenIssues();
    const status = stats.stoppedBecause
      ? StorageCheckStatus.Incomplete
      : stats.openIssues > 0
        ? StorageCheckStatus.Issues
        : StorageCheckStatus.Ok;
    await this.storageCheckRepository.finishRun(runId, status, stats);
    if (stats.newIssues > 0) {
      await this.notifyAdmin(stats);
    }
  }

  private async notifyAdmin({ newIssues, openIssues }: StorageCheckStats) {
    const admin = await this.userRepository.getAdmin();
    if (!admin) {
      return;
    }
    const notification = await this.notificationRepository.create({
      userId: admin.id,
      type: NotificationType.SystemMessage,
      level: NotificationLevel.Error,
      title: 'Storage check found problems',
      description: `${newIssues} new problems with stored files were found; ${openIssues} are open. See the data health report.`,
    });
    this.websocketRepository.clientSend('on_notification', admin.id, mapNotification(notification));
  }
}
