import { Mocked, vitest } from 'vitest';
import type { RepositoryInterface } from 'src/types.js';
import { StorageReplicaRepository } from 'src/repositories/storage-replica.repository.js';

/** No replicas and no copies, so that services that store or delete files work without setup */
export const newStorageReplicaRepositoryMock = (): Mocked<RepositoryInterface<StorageReplicaRepository>> => ({
  getSources: vitest.fn().mockResolvedValue([]),
  setSources: vitest.fn().mockResolvedValue([]),
  registerMissing: vitest.fn().mockResolvedValue({ registered: 0 }),
  claim: vitest.fn().mockResolvedValue([]),
  complete: vitest.fn().mockResolvedValue(true),
  recordFailure: vitest.fn().mockResolvedValue(undefined),
  countCopies: vitest.fn().mockResolvedValue(0),
  sampleCopies: vitest.fn().mockResolvedValue([]),
  retryFailed: vitest.fn().mockResolvedValue(0),
  getStatus: vitest.fn().mockResolvedValue([]),
  getFailing: vitest.fn().mockResolvedValue([]),
  countSourceFiles: vitest.fn().mockResolvedValue(0),
  getCopiesOf: vitest.fn().mockResolvedValue([]),
  remove: vitest.fn().mockResolvedValue(undefined),
  findMissing: vitest.fn().mockResolvedValue([]),
  findSizeMismatches: vitest.fn().mockResolvedValue([]),
  findUntracked: vitest.fn().mockResolvedValue([]),
  requeue: vitest.fn().mockResolvedValue(undefined),
});
