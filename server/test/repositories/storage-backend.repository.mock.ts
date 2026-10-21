import { Kysely } from 'kysely';
import { Mocked, vitest } from 'vitest';
import type { RepositoryInterface } from 'src/types.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageBackendRepository } from 'src/repositories/storage-backend.repository.js';
import { DB } from 'src/schema/index.js';

/** Resolves like the real repository (which does not touch the filesystem), so services see real locations */
export const newStorageBackendRepositoryMock = (): Mocked<RepositoryInterface<StorageBackendRepository>> => {
  const real = new StorageBackendRepository(
    undefined as unknown as Kysely<DB>,
    { setContext: () => {}, warn: () => {} } as unknown as LoggingRepository,
  );
  return {
    readConfig: vitest.fn(),
    configure: vitest.fn((backends) => real.configure(backends)),
    get: vitest.fn((backendId: string) => real.get(backendId)),
    getLocalPath: vitest.fn((file) => real.getLocalPath(file)),
    lease: vitest.fn((file) => real.lease(file)),
    getRegistered: vitest.fn().mockResolvedValue([
      { id: 'host', driver: 'local' },
      { id: 'media', driver: 'local' },
    ]),
    register: vitest.fn(),
    isInUse: vitest.fn().mockResolvedValue(false),
  };
};
