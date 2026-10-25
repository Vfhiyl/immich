import { Mocked, vitest } from 'vitest';
import type { RepositoryInterface } from 'src/types.js';
import { JobFailureRepository } from 'src/repositories/job-failure.repository.js';

/** No failed jobs, so that jobs run and are queued as upstream's without setup */
export const newJobFailureRepositoryMock = (): Mocked<RepositoryInterface<JobFailureRepository>> => ({
  start: vitest.fn().mockResolvedValue(undefined),
  finish: vitest.fn().mockResolvedValue(undefined),
  fail: vitest.fn().mockResolvedValue(undefined),
  getHeldBack: vitest.fn().mockResolvedValue([]),
  getCounts: vitest.fn().mockResolvedValue([]),
  getHeldBackAssets: vitest.fn().mockResolvedValue([]),
  release: vitest.fn().mockResolvedValue([]),
});
