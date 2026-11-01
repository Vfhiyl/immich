import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * A job put back in its queue to run later, rather than failed: its place in the queue goes to the next job meanwhile,
 * and it does not count as an attempt on its file. `data` is kept in the job for when it runs again
 */
export class JobRetryLater extends Error {
  constructor(
    message: string,
    public delayMs: number,
    public data: Partial<JobRetryData> = {},
  ) {
    super(message);
    this.name = 'JobRetryLater';
  }
}

/** What a job keeps in its data across the times it was put back */
export interface JobRetryData {
  /** When it began to wait for the memory of its heavy work (see MediaRepository.admit) */
  admissionWaitingSince: number;
  /** The times in a row it failed because of the environment (see isEnvironmentFailure) */
  environmentRetries: number;
}

const context = new AsyncLocalStorage<Partial<JobRetryData>>();

/** Runs a job with what it kept across the times it was put back (see getJobRetryData) */
export const withJobRetryData = <T>(data: unknown, run: () => T): T => {
  const { admissionWaitingSince, environmentRetries } = (data ?? {}) as Partial<JobRetryData>;
  return context.run({ admissionWaitingSince, environmentRetries }, run);
};

/** Of the job that runs, what it kept; undefined outside of a job (a request of the api) */
export const getJobRetryData = () => context.getStore();

/** The machine learning service did not answer, or answered with an error, at any of its addresses */
export class MachineLearningUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MachineLearningUnavailableError';
  }
}

/** Errors of the system and the network that are not those of a file (errno(3), getaddrinfo(3)) */
const ENVIRONMENT_CODES = new Set([
  'ENOSPC',
  'EDQUOT',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * Whether a job failed because of where it ran rather than of its file: the disk is full, the machine learning
 * service or a storage service does not answer or answers that it is busy or broken (HTTP 429, 5xx). The job is put
 * back for later, and it does not count as an attempt on its file (see JobService.onJobRun)
 */
export const isEnvironmentFailure = (error: unknown): boolean => {
  for (let current = error, depth = 0; current && typeof current === 'object' && depth < 5; depth++) {
    if (current instanceof MachineLearningUnavailableError) {
      return true;
    }
    const { code, statusCode, $metadata, $retryable } = current as {
      code?: unknown;
      statusCode?: unknown;
      $metadata?: { httpStatusCode?: unknown };
      $retryable?: unknown;
    };
    if (typeof code === 'string' && ENVIRONMENT_CODES.has(code)) {
      return true;
    }
    // AWS SDK (S3) and Azure SDK errors
    const status = typeof statusCode === 'number' ? statusCode : $metadata?.httpStatusCode;
    if ((typeof status === 'number' && (status === 429 || status >= 500)) || $retryable) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};

/** A job failed because of the environment too many times in a row: it fails, but not on its file */
export class EnvironmentFailure extends Error {
  constructor(cause: Error) {
    super(`${cause.message} (the environment, not the file: tried ${ENVIRONMENT_RETRIES} times)`, { cause });
    this.name = 'EnvironmentFailure';
  }
}

/** A job that failed because of the environment is put back this many times in a row, then fails (not on its file) */
export const ENVIRONMENT_RETRIES = 8;

/** After `retries` in a row: 1 minute, doubling up to 30 (8 tries take some 2 hours) */
export const getEnvironmentRetryDelay = (retries: number) => Math.min(60_000 * 2 ** retries, 30 * 60_000);
