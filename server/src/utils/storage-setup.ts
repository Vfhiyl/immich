import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { StorageBackendConfig, StorageBackendsConfig } from 'src/dtos/storage-backend-config.dto.js';
import { StorageBackendRole, StorageSetupProblemKind } from 'src/enum.js';
import { KeyProvider } from 'src/repositories/key-provider.js';
import { STORAGE_PROBE_PREFIX, StorageBackendRepository } from 'src/repositories/storage-backend.repository.js';
import { listStoredDatabaseBackups } from 'src/utils/stored-database-backups.js';

export interface StorageSetupProblem {
  kind: StorageSetupProblemKind;
  /** The file it is about, inside the container */
  path?: string;
  backendId?: string;
  keyId?: string;
  /** What went wrong, as the server saw it */
  message: string;
}

export interface StorageSetupReport {
  /** The storage configuration file (IMMICH_STORAGE_BACKENDS), null without one: files are kept in the media location */
  configFile: string | null;
  masterKeyFile: string | null;
  /** The program of the master key command */
  masterKeyCommand: string | null;
  /** The current master key, when the keys could be read */
  masterKeyId: string | null;
  backends: Array<{
    id: string;
    role: StorageBackendRole;
    driver: string;
    encrypted: boolean;
    /** Whether the backend passed the check of writing, reading back and deleting a probe */
    ok: boolean;
  }>;
  problems: StorageSetupProblem[];
  /** Whether the backend for originals holds files already, e.g. of a server that is restored */
  hasOriginals: boolean;
  /** The database backups on the backend for backups, the newest first */
  databaseBackups: Array<{ key: string; filename: string; size: number; createdAt: string }>;
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const missingKeyOf = (error: unknown) => /Master key ([0-9a-f]+) is not available/.exec(messageOf(error))?.[1];

/**
 * Write a probe to a backend, read it back (decrypted, if the backend encrypts) and delete it with the credentials of
 * the cleanup; throws what went wrong
 */
export const probeStorageBackend = async (
  repository: StorageBackendRepository,
  backendId: string,
  onLeftover: (key: string) => void,
) => {
  const store = repository.getWriteStore(backendId);
  const key = `${STORAGE_PROBE_PREFIX}/${randomUUID()}`;
  const content = Buffer.from(`immich storage probe ${key}`);

  const written = await store.put(key, Readable.from([content]));
  const read = await buffer(await store.get(key, { expect: written, encryption: written.encryption }));
  if (!read.equals(content)) {
    throw new Error('the probe read back different content');
  }
  // deleted with the credentials of the cleanup, which are checked too
  const { failed } = await repository.getDeletionStore(backendId).deleteMany([key]);
  if (failed.length > 0) {
    onLeftover(key);
  }
};

/** The first file of a backend, not counting probes */
const firstFile = async (repository: StorageBackendRepository, backendId: string) => {
  for await (const { key } of repository.get(backendId).list()) {
    if (!key.startsWith(`${STORAGE_PROBE_PREFIX}/`)) {
      return key;
    }
  }
};

/**
 * Check the storage of a server as it starts: the configuration file, the master keys, every backend (with a probe),
 * and what storage holds already (originals, database backups), which a new server finds when it replaces a lost
 * one. Configures `repository` as it goes. Every problem found is reported, rather than the first one thrown, so that
 * a deployer sees everything that is wrong at once.
 */
export const checkStorageSetup = async ({
  backendsFile,
  repository,
  probe = true,
}: {
  backendsFile: string | undefined;
  repository: StorageBackendRepository;
  /** Whether to write probes; a server that started has probed its backends already */
  probe?: boolean;
}): Promise<StorageSetupReport> => {
  const report: StorageSetupReport = {
    configFile: backendsFile ?? null,
    masterKeyFile: null,
    masterKeyCommand: null,
    masterKeyId: null,
    backends: [],
    problems: [],
    hasOriginals: false,
    databaseBackups: [],
  };
  if (!backendsFile) {
    return report;
  }

  let config: StorageBackendsConfig;
  try {
    config = await repository.readConfig(backendsFile);
  } catch (error) {
    report.problems.push(
      errorCode(error) === 'ENOENT'
        ? { kind: StorageSetupProblemKind.ConfigurationMissing, path: backendsFile, message: messageOf(error) }
        : { kind: StorageSetupProblemKind.ConfigurationInvalid, path: backendsFile, message: messageOf(error) },
    );
    return report;
  }

  const { backends, encryption, deletion, databaseBackups } = config;
  report.masterKeyFile = encryption?.masterKeyFile ?? null;
  report.masterKeyCommand = encryption?.masterKeyCommand?.[0] ?? null;
  report.backends = backends.map(({ id, role, driver, encrypted }) => ({ id, role, driver, encrypted, ok: false }));

  let keys: KeyProvider | undefined;
  if (encryption) {
    try {
      keys = repository.readMasterKeys(encryption);
      report.masterKeyId = keys.currentKeyId.toString('hex');
    } catch (error) {
      report.problems.push(
        errorCode(error) === 'ENOENT'
          ? {
              kind: StorageSetupProblemKind.MasterKeyFileMissing,
              path: encryption.masterKeyFile,
              message: messageOf(error),
            }
          : {
              kind: StorageSetupProblemKind.MasterKeysInvalid,
              path: encryption.masterKeyFile,
              message: messageOf(error),
            },
      );
    }
  }

  // without the keys, encrypted backends cannot be checked; the others still can
  const usable: StorageBackendConfig[] = keys ? backends : backends.filter(({ encrypted }) => !encrypted);
  try {
    repository.configure(usable, keys, deletion, databaseBackups);
  } catch (error) {
    report.problems.push({
      kind: StorageSetupProblemKind.ConfigurationInvalid,
      path: backendsFile,
      message: messageOf(error),
    });
    return report;
  }

  for (const backend of usable) {
    try {
      if (probe) {
        await probeStorageBackend(repository, backend.id, () => {});
      }
      report.backends.find(({ id }) => id === backend.id)!.ok = true;
    } catch (error) {
      report.problems.push({
        kind: StorageSetupProblemKind.BackendFailed,
        backendId: backend.id,
        message: messageOf(error),
      });
    }
  }

  const isOk = (role: StorageBackendRole) => {
    const backend = report.backends.find((backend) => backend.role === role);
    return backend?.ok ? backend : undefined;
  };
  const missingKeys = new Set<string>();

  const originals = isOk(StorageBackendRole.Originals);
  if (originals) {
    try {
      const key = await firstFile(repository, originals.id);
      report.hasOriginals = key !== undefined;
      if (key !== undefined && originals.encrypted) {
        await repository.getEncryptedStore(originals.id).describe(key);
      }
    } catch (error) {
      const keyId = missingKeyOf(error);
      if (keyId) {
        missingKeys.add(keyId);
      } else {
        report.problems.push({
          kind: StorageSetupProblemKind.BackendFailed,
          backendId: originals.id,
          message: messageOf(error),
        });
      }
    }
  }

  const backups = isOk(StorageBackendRole.Backup);
  if (backups) {
    try {
      const stored = await listStoredDatabaseBackups(repository.getEncryptedStore(backups.id), (_key, error) => {
        const keyId = missingKeyOf(error);
        if (keyId) {
          missingKeys.add(keyId);
        }
      });
      report.databaseBackups = stored.map(({ key, filename, size, createdAt }) => ({ key, filename, size, createdAt }));
    } catch (error) {
      report.problems.push({
        kind: StorageSetupProblemKind.BackendFailed,
        backendId: backups.id,
        message: messageOf(error),
      });
    }
  }

  for (const keyId of missingKeys) {
    report.problems.push({
      kind: StorageSetupProblemKind.MasterKeyNotFound,
      keyId,
      path: encryption?.masterKeyFile,
      message: `Files in storage were encrypted with master key ${keyId}, which is not among the configured master keys`,
    });
  }

  return report;
};
