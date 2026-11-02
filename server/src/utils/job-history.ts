import { isKilledProgram } from 'src/utils/memory-kills.js';

/** What kind of failure: the file's, a program stopped as stuck, killed as memory ran out, or the environment's */
export enum JobFailureCategory {
  File = 'file',
  Stuck = 'stuck',
  OutOfMemory = 'out_of_memory',
  Environment = 'environment',
}

/** The kind of a failure, by its error (see isEnvironmentFailure, watchProgress, isKilledProgram) */
export const classifyJobFailure = (error: Error, environment: boolean): JobFailureCategory => {
  if (environment) {
    return JobFailureCategory.Environment;
  }
  if (error.message.includes('made no progress')) {
    return JobFailureCategory.Stuck;
  }
  if (isKilledProgram(error)) {
    return JobFailureCategory.OutOfMemory;
  }
  return JobFailureCategory.File;
};

const REASON_LENGTH = 300;
const ERROR_LENGTH = 2000;

/**
 * An error without what differs from one file to another, for failures to be grouped by: ids, hashes, paths and
 * numbers become placeholders ("cannot open /a/b.heic: 12 bytes" and "cannot open /c.heic: 7 bytes" are one reason)
 */
export const getFailureReason = (message: string) =>
  message
    .split('\n', 1)[0]
    .replaceAll(/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/gi, '<id>')
    .replaceAll(/\b[\da-f]{16,}\b/gi, '<hash>')
    .replaceAll(/(^|[\s"'(=:])(\/[^\s"'),:]+)/g, '$1<path>')
    .replaceAll(/\d+(\.\d+)?/g, '<n>')
    .trim()
    .slice(0, REASON_LENGTH);

/** How a job ended, as counted for its hour */
export type JobOutcome = 'succeeded' | 'failed' | 'retried';

export interface JobRunCount {
  /** The hour, UTC, as an ISO date */
  hour: string;
  jobName: string;
  queueName: string;
  succeeded: number;
  failed: number;
  retried: number;
}

export interface JobFailureRecord {
  createdAt: Date;
  jobName: string;
  queueName: string;
  assetId: string | null;
  category: JobFailureCategory;
  reason: string;
  error: string;
}

/** The failures written at most at once; beyond, in a flood of them (a broken environment), the rest are counted only */
const PENDING_FAILURES = 1000;

/** Counts the jobs that end, and keeps the failures, in memory until they are written to the database */
export class JobHistoryRecorder {
  private counts = new Map<string, JobRunCount>();
  private failures: JobFailureRecord[] = [];

  record(
    queueName: string,
    jobName: string,
    outcome: JobOutcome,
    failure?: { error: Error; category: JobFailureCategory; assetId?: string },
    now = new Date(),
  ) {
    const hour = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000).toISOString();
    const id = `${hour}|${jobName}`;
    let count = this.counts.get(id);
    if (!count) {
      count = { hour, jobName, queueName, succeeded: 0, failed: 0, retried: 0 };
      this.counts.set(id, count);
    }
    count[outcome]++;
    if (failure && this.failures.length < PENDING_FAILURES) {
      this.failures.push({
        createdAt: now,
        jobName,
        queueName,
        assetId: failure.assetId ?? null,
        category: failure.category,
        reason: getFailureReason(failure.error.message),
        error: failure.error.message.slice(0, ERROR_LENGTH),
      });
    }
  }

  /** What was recorded since the last call, which is forgotten */
  drain() {
    const counts = this.counts.values().toArray();
    const failures = this.failures;
    this.counts.clear();
    this.failures = [];
    return { counts, failures };
  }
}
