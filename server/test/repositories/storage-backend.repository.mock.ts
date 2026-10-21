import { Mocked, vitest } from 'vitest';
import type { RepositoryInterface } from 'src/types.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageBackendRepository } from 'src/repositories/storage-backend.repository.js';

/** Resolves like the real repository (which does not touch the filesystem), so services see real locations */
export const newStorageBackendRepositoryMock = (): Mocked<RepositoryInterface<StorageBackendRepository>> => {
  const real = new StorageBackendRepository({ setContext: () => {}, warn: () => {} } as unknown as LoggingRepository);
  return {
    get: vitest.fn((backendId: string) => real.get(backendId)),
    getLocalPath: vitest.fn((file) => real.getLocalPath(file)),
  };
};
