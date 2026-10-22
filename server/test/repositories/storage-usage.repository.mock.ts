import { Mocked, vitest } from 'vitest';
import type { RepositoryInterface } from 'src/types.js';
import { StorageUsageRepository } from 'src/repositories/storage-usage.repository.js';

/** Nothing recorded, so that services that count storage requests work without setup */
export const newStorageUsageRepositoryMock = (): Mocked<RepositoryInterface<StorageUsageRepository>> => ({
  addRequests: vitest.fn().mockResolvedValue(undefined),
  recordStored: vitest.fn().mockResolvedValue(undefined),
  getRequests: vitest.fn().mockResolvedValue([]),
  getStored: vitest.fn().mockResolvedValue([]),
  removeBefore: vitest.fn().mockResolvedValue(undefined),
});
