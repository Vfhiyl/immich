import { Mocked, vitest } from 'vitest';
import type { RepositoryInterface } from 'src/types.js';
import { StorageDeletionRepository } from 'src/repositories/storage-deletion.repository.js';

/** Nothing registered and nothing due, so that services that delete files work without setup */
export const newStorageDeletionRepositoryMock = (): Mocked<RepositoryInterface<StorageDeletionRepository>> => ({
  register: vitest.fn().mockResolvedValue(undefined),
  registerUserFiles: vitest.fn().mockResolvedValue(undefined),
  getDue: vitest.fn().mockResolvedValue([]),
  countDueOriginals: vitest.fn().mockResolvedValue(0),
  countStoredOriginals: vitest.fn().mockResolvedValue(0),
  getRecorded: vitest.fn().mockResolvedValue([]),
  remove: vitest.fn().mockResolvedValue(undefined),
  recordFailure: vitest.fn().mockResolvedValue(undefined),
});
