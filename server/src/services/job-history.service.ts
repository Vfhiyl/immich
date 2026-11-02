import { Injectable } from '@nestjs/common';
import { OnEvent } from 'src/decorators.js';
import {
  JobFailureListQueryDto,
  JobFailureListResponseDto,
  JobHistoryQueryDto,
  JobHistoryResponseDto,
} from 'src/dtos/job-history.dto.js';
import { mapNotification } from 'src/dtos/notification.dto.js';
import { ImmichWorker, NotificationLevel, NotificationType, SystemMetadataKey } from 'src/enum.js';
import { JobHistoryUnit } from 'src/repositories/job-history.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { JobFailureCategory } from 'src/utils/job-history.js';
import { handlePromiseError } from 'src/utils/misc.js';

const FLUSH_MS = 10 * 1000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Failures kept: of the last year, at most this many (the counts of jobs are kept for good) */
const FAILURES_KEPT_DAYS = 365;
const FAILURES_KEPT = 200_000;
const REASONS_LISTED = 50;

/**
 * A job fails far more often than usual when, in the last 24 hours, it ran at least ALERT_MIN_RUNS times, at least
 * ALERT_RATE of them failed, and that is ALERT_FACTOR times the share that failed in the 30 days before (or more)
 */
export const JOB_ALERT = { minRuns: 20, rate: 0.2, factor: 3 };

/** The unit of a series from `since`: hours up to 3 days, days up to 3 months, else months */
export const getHistoryUnit = (since: Date | undefined, now: Date): JobHistoryUnit => {
  if (!since) {
    return 'month';
  }
  const span = now.getTime() - since.getTime();
  return span <= 3 * DAY ? 'hour' : span <= 92 * DAY ? 'day' : 'month';
};

const toRuns = (row: {
  succeeded: string | number | null;
  failed: string | number | null;
  retried: string | number | null;
}) => ({
  succeeded: Number(row.succeeded ?? 0),
  failed: Number(row.failed ?? 0),
  retried: Number(row.retried ?? 0),
});

/**
 * The history of jobs for the admin: how many ran and failed over time, why they failed, and the jobs that fail far
 * more often than usual (the admin is notified of those, at most once a day for each job)
 */
@Injectable()
export class JobHistoryService extends BaseService {
  private flushTimer?: ReturnType<typeof setInterval>;
  private checkTimer?: ReturnType<typeof setInterval>;

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  onBootstrap() {
    this.flushTimer = setInterval(() => handlePromiseError(this.jobHistoryRepository.flush(), this.logger), FLUSH_MS);
    this.checkTimer = setInterval(() => handlePromiseError(this.check(), this.logger), HOUR);
  }

  @OnEvent({ name: 'AppShutdown', workers: [ImmichWorker.Microservices] })
  async onShutdown() {
    clearInterval(this.flushTimer);
    clearInterval(this.checkTimer);
    await this.jobHistoryRepository.flush();
  }

  /** Every hour: keeps the failures of the last year, and tells the admin of jobs that fail far more often than usual */
  async check(now = new Date()) {
    await this.jobHistoryRepository.removeOldFailures(FAILURES_KEPT_DAYS, FAILURES_KEPT);
    const alerts = await this.getAlerts(now);
    if (alerts.length === 0) {
      return;
    }
    const notified: Record<string, string> =
      (await this.systemMetadataRepository.get(SystemMetadataKey.JobHistoryAlerts)) ?? {};
    const due = alerts.filter(
      ({ jobName }) => !notified[jobName] || now.getTime() - Date.parse(notified[jobName]) >= DAY,
    );
    if (due.length === 0) {
      return;
    }
    const admin = await this.userRepository.getAdmin();
    if (admin) {
      const notification = await this.notificationRepository.create({
        userId: admin.id,
        type: NotificationType.SystemMessage,
        level: NotificationLevel.Warning,
        title: 'Jobs fail more often than usual',
        description: due
          .map(({ jobName, runs, failed }) => `${jobName}: ${failed} of ${runs} failed in the last 24 hours`)
          .join('; ')
          .concat('. See the history of jobs on the jobs page for why.'),
      });
      this.websocketRepository.clientSend('on_notification', admin.id, mapNotification(notification));
    }
    for (const { jobName } of due) {
      notified[jobName] = now.toISOString();
    }
    await this.systemMetadataRepository.set(SystemMetadataKey.JobHistoryAlerts, notified);
  }

  async getHistory({ since }: JobHistoryQueryDto, now = new Date()): Promise<JobHistoryResponseDto> {
    // what was counted in this process and not yet written (the api's own jobs are none: it runs no jobs)
    await this.jobHistoryRepository.flush();
    const from = since ? new Date(since) : undefined;
    const unit = getHistoryUnit(from, now);
    const [jobs, series, reasons, alerts] = await Promise.all([
      this.jobHistoryRepository.getTotals(from),
      this.jobHistoryRepository.getSeries(from, unit),
      this.jobHistoryRepository.getReasons(from, REASONS_LISTED),
      this.getAlerts(now),
    ]);
    const mappedJobs = jobs.map((job) => ({ jobName: job.jobName, queueName: job.queueName, ...toRuns(job) }));
    const totals = { succeeded: 0, failed: 0, retried: 0 };
    for (const job of mappedJobs) {
      totals.succeeded += job.succeeded;
      totals.failed += job.failed;
      totals.retried += job.retried;
    }
    return {
      unit,
      totals,
      jobs: mappedJobs,
      series: series.map((bucket) => ({ start: new Date(bucket.start).toISOString(), ...toRuns(bucket) })),
      reasons: reasons.map((reason) => ({
        jobName: reason.jobName,
        category: reason.category as JobFailureCategory,
        reason: reason.reason,
        count: Number(reason.count),
        lastAt: new Date(reason.lastAt).toISOString(),
      })),
      alerts,
    };
  }

  async getFailures(dto: JobFailureListQueryDto): Promise<JobFailureListResponseDto> {
    const { page = 1, size = 50, since, ...filter } = dto;
    const query = { ...filter, since: since ? new Date(since) : undefined };
    const [total, items] = await Promise.all([
      this.jobHistoryRepository.countFailures(query),
      this.jobHistoryRepository.getFailures(query, size, (page - 1) * size),
    ]);
    return {
      total,
      items: items.map((item) => ({
        ...item,
        category: item.category as JobFailureCategory,
        createdAt: new Date(item.createdAt).toISOString(),
        originalFileName: item.originalFileName ?? null,
      })),
    };
  }

  /** The jobs that failed far more often than usual in the last 24 hours (see JOB_ALERT) */
  private async getAlerts(now: Date) {
    const [day, month] = await Promise.all([
      this.jobHistoryRepository.getTotals(new Date(now.getTime() - DAY)),
      this.jobHistoryRepository.getTotals(new Date(now.getTime() - 31 * DAY)),
    ]);
    const before = new Map(month.map((job) => [job.jobName, toRuns(job)]));
    const alerts = [];
    for (const job of day) {
      const { succeeded, failed } = toRuns(job);
      const runs = succeeded + failed;
      if (runs < JOB_ALERT.minRuns || failed / runs < JOB_ALERT.rate) {
        continue;
      }
      const all = before.get(job.jobName) ?? { succeeded: 0, failed: 0 };
      const usualRuns = all.succeeded + all.failed - runs;
      const usualRate = usualRuns > 0 ? (all.failed - failed) / usualRuns : null;
      if (usualRate === null || failed / runs >= JOB_ALERT.factor * usualRate) {
        alerts.push({ jobName: job.jobName, runs, failed, usualRate });
      }
    }
    return alerts;
  }
}
