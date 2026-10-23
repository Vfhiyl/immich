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
    { setContext: () => {}, warn: () => {}, debug: () => {} } as unknown as LoggingRepository,
  );
  // there is no database: writes are not registered
  real.registerWrite = () => Promise.resolve();
  return {
    registerWrite: vitest.fn().mockResolvedValue(undefined),
    createDetached: vitest.fn(() => real.createDetached()),
    readConfig: vitest.fn(),
    readMasterKeys: vitest.fn(),
    configure: vitest.fn((backends, keys, deletion, databaseBackups) =>
      real.configure(backends, keys, deletion, databaseBackups),
    ),
    getDatabaseBackupsKeepLast: vitest.fn(() => real.getDatabaseBackupsKeepLast()),
    get: vitest.fn((backendId: string) => real.get(backendId)),
    getWriteStore: vitest.fn((backendId: string) => real.getWriteStore(backendId)),
    getEncryptedStore: vitest.fn((backendId: string) => real.getEncryptedStore(backendId)),
    getDeletionStore: vitest.fn((backendId: string) => real.getDeletionStore(backendId)),
    getDeletionDelay: vitest.fn((backendId: string) => real.getDeletionDelay(backendId)),
    getOriginalsDeletionDelayDays: vitest.fn(() => real.getOriginalsDeletionDelayDays()),
    getLocalPath: vitest.fn((file) => real.getLocalPath(file)),
    lease: vitest.fn((file) => real.lease(file)),
    resolve: vitest.fn((file) => real.resolve(file)),
    toFileSource: vitest.fn((file) => real.toFileSource(file)),
    getBackendFor: vitest.fn((role) => real.getBackendFor(role)),
    hasConfiguredBackends: vitest.fn(() => real.hasConfiguredBackends()),
    getConfiguredBackends: vitest.fn(() => real.getConfiguredBackends()),
    describeConfiguration: vitest.fn(() => real.describeConfiguration()),
    exportMasterKeys: vitest.fn(() => real.exportMasterKeys()),
    getReplicaSources: vitest.fn(() => real.getReplicaSources()),
    getEncryptedReplicaStore: vitest.fn((replicaBackendId, sourceBackendId) =>
      real.getEncryptedReplicaStore(replicaBackendId, sourceBackendId),
    ),
    getReplicaStore: vitest.fn((replicaBackendId, sourceBackendId, options) =>
      real.getReplicaStore(replicaBackendId, sourceBackendId, options),
    ),
    createOutput: vitest.fn((role, path, options) => real.createOutput(role, path, options)),
    storeFile: vitest.fn((role, path, options) => real.storeFile(role, path, options)),
    canKeepLocalCopy: vitest.fn((location, size) => real.canKeepLocalCopy(location, size)),
    keepLocalCopy: vitest.fn((stored, path) => real.keepLocalCopy(stored, path)),
    dropLocalCopy: vitest.fn((file) => real.dropLocalCopy(file)),
    sweepLocalCopies: vitest.fn(() => real.sweepLocalCopies()),
    sweepTemporaryFiles: vitest.fn((before) => real.sweepTemporaryFiles(before)),
    drainRequestUsage: vitest.fn(() => real.drainRequestUsage()),
    getRegistered: vitest.fn().mockResolvedValue([
      { id: 'host', driver: 'local' },
      { id: 'media', driver: 'local' },
    ]),
    register: vitest.fn(),
    isInUse: vitest.fn().mockResolvedValue(false),
    getMasterKeyIds: vitest.fn().mockResolvedValue([]),
    registerMasterKey: vitest.fn(),
  };
};
