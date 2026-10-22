import { Injectable } from '@nestjs/common';
import { chunk, partition } from 'lodash-es';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import type { JobOf, SystemFlags } from 'src/types.js';
import { ErrorMessages } from 'src/constants.js';
import { StorageCore, StorageLocation } from 'src/cores/storage.core.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { StorageBackendConfig, StorageBackendsConfig, describeKeySource } from 'src/dtos/storage-backend-config.dto.js';
import { StorageConfigurationResponseDto } from 'src/dtos/storage-backend.dto.js';
import {
  BootstrapEventPriority,
  BuiltinStorageBackend,
  DatabaseLock,
  ImmichWorker,
  JobName,
  JobStatus,
  QueueName,
  StorageFolder,
  SystemMetadataKey,
} from 'src/enum.js';
import { KeyProvider } from 'src/repositories/key-provider.js';
import { PersonId } from 'src/repositories/person.repository.js';
import { STORAGE_PROBE_PREFIX, isBuiltinStorageBackend } from 'src/repositories/storage-backend.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { ImmichStartupError } from 'src/utils/misc.js';

/** What a write that was cut off left on a local backend is removed after this long */
const TEMPORARY_FILE_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;
/** Number of asset files given a storage location per database round trip */
const FILE_LOCATION_BATCH_SIZE = 5000;
/** Where startup checks write their probes in each configured storage backend */

type FileWithPath = { id: string; path: string };

const docsMessage = `Please see https://docs.immich.app/administration/system-integrity#folder-checks for more information.`;

@Injectable()
export class StorageService extends BaseService {
  private detectMediaLocation(): string {
    const envData = this.configRepository.getEnv();
    if (envData.storage.mediaLocation) {
      return envData.storage.mediaLocation;
    }

    const targets: string[] = [];
    const candidates = ['/data', '/usr/src/app/upload'];

    for (const candidate of candidates) {
      const isExists = this.storageRepository.existsSync(candidate);
      if (isExists) {
        targets.push(candidate);
      }
    }

    if (targets.length === 1) {
      return targets[0];
    }

    return '/usr/src/app/upload';
  }

  @OnEvent({ name: 'AppBootstrap', priority: BootstrapEventPriority.StorageService })
  async onBootstrap() {
    StorageCore.setMediaLocation(this.detectMediaLocation());

    await this.databaseRepository.withLock(DatabaseLock.SystemFileMounts, async () => {
      const flags =
        (await this.systemMetadataRepository.get(SystemMetadataKey.SystemFlags)) ||
        ({ mountChecks: {} } as SystemFlags);

      if (!flags.mountChecks) {
        flags.mountChecks = {};
      }

      let isUpdated = false;

      this.logger.log(`Verifying system mount folder checks, current state: ${JSON.stringify(flags)}`);

      try {
        // check each folder exists and is writable
        for (const folder of Object.values(StorageFolder)) {
          if (!flags.mountChecks[folder]) {
            this.logger.log(`Writing initial mount file for the ${folder} folder`);
            await this.createMountFile(folder);
          }

          await this.verifyReadAccess(folder);
          await this.verifyWriteAccess(folder);

          if (flags.mountChecks[folder]) {
            continue;
          }

          flags.mountChecks[folder] = true;
          isUpdated = true;
        }

        if (isUpdated) {
          await this.systemMetadataRepository.set(SystemMetadataKey.SystemFlags, flags);
          this.logger.log('Successfully enabled system mount folders checks');
        }

        this.logger.log('Successfully verified system mount folder checks');
      } catch (error) {
        const envData = this.configRepository.getEnv();
        if (envData.storage.ignoreMountCheckErrors) {
          this.logger.error(error as Error);
          this.logger.warn('Ignoring mount folder errors');
        } else {
          throw error;
        }
      }
    });

    await this.databaseRepository.withLock(DatabaseLock.MediaLocation, async () => {
      const current = StorageCore.getMediaLocation();
      const samples = await this.assetRepository.getFileSamples();
      const savedValue = await this.systemMetadataRepository.get(SystemMetadataKey.MediaLocation);
      if (samples.length > 0) {
        const path = samples[0].path;

        let previous = savedValue?.location || '';

        if (!previous && this.configRepository.getEnv().storage.mediaLocation) {
          previous = current;
        }

        if (!previous) {
          previous = path.startsWith('upload/') ? 'upload' : '/usr/src/app/upload';
        }

        if (previous !== current) {
          this.logger.log(`Media location changed (from=${previous}, to=${current})`);

          if (!path.startsWith(previous)) {
            throw new Error(ErrorMessages.InconsistentMediaLocation);
          }

          this.logger.warn(
            `Detected a change to media location, performing an automatic migration of file paths from ${previous} to ${current}, this may take awhile`,
          );
          await this.databaseRepository.migrateFilePaths(previous, current);
        }
      }

      // Only set MediaLocation in systemMetadataRepository if needed
      if (savedValue?.location !== current) {
        await this.systemMetadataRepository.set(SystemMetadataKey.MediaLocation, { location: current });
      }
    });
  }

  @OnEvent({ name: 'AppBootstrap', priority: BootstrapEventPriority.StorageBackends })
  async onBootstrapStorageBackends() {
    const { backendsFile } = this.configRepository.getEnv().storage;
    let backends: StorageBackendConfig[] = [];
    let encryption: StorageBackendsConfig['encryption'];
    let deletion: StorageBackendsConfig['deletion'] | undefined;
    let databaseBackups: StorageBackendsConfig['databaseBackups'] | undefined;
    let keys: KeyProvider | undefined;
    if (backendsFile) {
      try {
        ({ backends, encryption, deletion, databaseBackups } =
          await this.storageBackendRepository.readConfig(backendsFile));
        if (encryption) {
          keys = this.storageBackendRepository.readMasterKeys(encryption);
        }
      } catch (error) {
        throw new ImmichStartupError(`Unable to load the storage backend configuration: ${error}`);
      }
    }

    await this.databaseRepository.withLock(DatabaseLock.StorageBackends, async () => {
      const registered = await this.storageBackendRepository.getRegistered();
      const configuredIds = new Set(backends.map(({ id }) => id));

      for (const backend of backends) {
        const existing = registered.find(({ id }) => id === backend.id);
        if (existing && existing.driver !== backend.driver) {
          throw new ImmichStartupError(
            `Storage backend ${backend.id} is configured with the ${backend.driver} driver, but its files were written with the ${existing.driver} driver`,
          );
        }
      }

      // files on a backend can only be read while it is configured
      for (const { id } of registered) {
        if (
          !isBuiltinStorageBackend(id) &&
          !configuredIds.has(id) &&
          (await this.storageBackendRepository.isInUse(id))
        ) {
          throw new ImmichStartupError(
            `Storage backend ${id} still holds files but is not configured${backendsFile ? ` in ${backendsFile}` : ''}`,
          );
        }
      }

      // files encrypted with a key that is gone cannot be read, so a key file that lost a key must not go unnoticed
      const usedKeys = await this.storageBackendRepository.getMasterKeyIds();
      const missingKeys = usedKeys.filter((id) => !keys?.hasKey(id));
      if (missingKeys.length > 0) {
        const ids = missingKeys.map((id) => id.toString('hex')).join(', ');
        throw new ImmichStartupError(
          encryption
            ? `Files were encrypted with master keys that are not in ${describeKeySource(encryption)}: ${ids}`
            : `Files were encrypted with master keys ${ids}, but no master keys are configured (encryption.masterKeyFile or encryption.masterKeyCommand)`,
        );
      }
      if (keys && backends.some(({ encrypted }) => encrypted)) {
        await this.storageBackendRepository.registerMasterKey(keys.currentKeyId);
      }

      const registeredIds = new Set(registered.map(({ id }) => id));
      await this.storageBackendRepository.register(
        backends.filter(({ id }) => !registeredIds.has(id)).map(({ id, driver }) => ({ id, driver })),
      );
    });

    this.storageBackendRepository.configure(backends, keys, deletion, databaseBackups);

    for (const backend of backends) {
      await this.probeStorageBackend(backend.id);
    }

    if (backends.length > 0) {
      this.logger.log(`Using storage backends: ${backends.map(({ id, role }) => `${id} (${role})`).join(', ')}`);
    }
  }

  /** The storage configuration, as administrators may see it */
  getConfiguration(): StorageConfigurationResponseDto {
    return {
      ...this.storageBackendRepository.describeConfiguration(),
      syncDeleteRetentionDays: this.configRepository.getEnv().sync.deleteRetentionDays,
    };
  }

  /** Check that a backend accepts writes and returns what was written (encrypted, if it encrypts), then remove the probe */
  private async probeStorageBackend(backendId: string) {
    const store = this.storageBackendRepository.getWriteStore(backendId);
    const key = `${STORAGE_PROBE_PREFIX}/${this.cryptoRepository.randomUUID()}`;
    const content = Buffer.from(`immich storage probe ${key}`);

    try {
      const written = await store.put(key, Readable.from([content]));
      const read = await buffer(await store.get(key, { expect: written, encryption: written.encryption }));
      if (!read.equals(content)) {
        throw new Error('the probe read back different content');
      }
      // deleted with the credentials of the cleanup, which are checked too
      const { failed } = await this.storageBackendRepository.getDeletionStore(backendId).deleteMany([key]);
      if (failed.length > 0) {
        this.logger.warn(`Unable to remove the probe ${key} from storage backend ${backendId}`);
      }
    } catch (error) {
      throw new ImmichStartupError(`Storage backend ${backendId} failed the startup check: ${error}`);
    }
  }

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  async onBootstrapFileLocations() {
    const pending = await Promise.all([
      this.assetRepository.hasFilesWithoutLocation(),
      this.assetRepository.hasAssetsWithoutOriginalFile(),
      this.personRepository.hasPeopleWithoutThumbnailFile(),
      this.userRepository.hasUsersWithoutProfileImageFile(),
    ]);
    if (pending.some(Boolean)) {
      await this.jobRepository.queue({ name: JobName.FileLocationBackfill });
    }
  }

  /** Give files recorded before storage backends existed a backend and key, derived from their path */
  @OnJob({ name: JobName.LocalCopyCleanup, queue: QueueName.BackgroundTask })
  async handleLocalCopyCleanup(): Promise<JobStatus> {
    await this.storageBackendRepository.sweepLocalCopies();
    // writes in progress, and uploads that are resumed within their day, are younger
    const before = new Date(Date.now() - TEMPORARY_FILE_MAX_AGE_MS);
    const removed = await this.storageBackendRepository.sweepTemporaryFiles(before);
    if (removed > 0) {
      this.logger.log(`Removed ${removed} files left by writes to storage backends that were cut off`);
    }
    return JobStatus.Success;
  }

  @OnJob({ name: JobName.FileLocationBackfill, queue: QueueName.BackgroundTask })
  async handleFileLocationBackfill(): Promise<JobStatus> {
    await this.backfillLocations<FileWithPath>('asset file', {
      getPage: (after, limit) => this.assetRepository.getFilesWithoutLocation({ afterId: after?.id, limit }),
      getName: ({ id }) => id,
      setLocations: (locations) => this.assetRepository.setFileLocations(locations),
    });
    await this.backfillLocations<FileWithPath>('original file', {
      getPage: (after, limit) => this.assetRepository.getAssetsWithoutOriginalFile({ afterId: after?.id, limit }),
      getName: ({ id }) => id,
      setLocations: (locations) => this.assetRepository.setOriginalFiles(locations),
    });
    await this.backfillLocations<PersonId & { path: string }>('person thumbnail', {
      getPage: (after, limit) => this.personRepository.getPeopleWithoutThumbnailFile({ after, limit }),
      getName: ({ ownerId, personGroupId }) => `${personGroupId} of user ${ownerId}`,
      setLocations: (locations) => this.personRepository.setThumbnailFiles(locations),
    });
    await this.backfillLocations<FileWithPath>('profile image', {
      getPage: (after, limit) => this.userRepository.getUsersWithoutProfileImageFile({ afterId: after?.id, limit }),
      getName: ({ id }) => id,
      setLocations: (locations) => this.userRepository.setProfileImageFiles(locations),
    });

    return JobStatus.Success;
  }

  private async backfillLocations<T extends { path: string }>(
    label: string,
    source: {
      /** The next page in a stable order, after the last item of the previous page */
      getPage: (after: T | undefined, limit: number) => Promise<T[]>;
      getName: (item: T) => string;
      setLocations: (locations: Array<Omit<T, 'path'> & StorageLocation>) => Promise<number>;
    },
  ) {
    let after: T | undefined;
    let updated = 0;
    let invalid = 0;
    let shared = 0;

    while (true) {
      const items = await source.getPage(after, FILE_LOCATION_BATCH_SIZE);
      if (items.length === 0) {
        break;
      }
      after = items.at(-1);

      const seen = new Set<string>();
      const locations: Array<Omit<T, 'path'> & StorageLocation> = [];
      for (const item of items) {
        let location;
        try {
          location = StorageCore.getStorageLocation(item.path);
        } catch (error) {
          invalid++;
          this.logger.warn(
            `Unable to determine the storage location of ${label} ${source.getName(item)} (${item.path}): ${error}`,
          );
          continue;
        }

        // Only one file can point to a blob that Immich owns; host files may be shared (see asset_file indexes)
        if (location.backendId !== BuiltinStorageBackend.Host) {
          const locationId = `${location.backendId}:${location.key}`;
          if (seen.has(locationId)) {
            shared++;
            continue;
          }
          seen.add(locationId);
        }

        const { path: _path, ...identity } = item;
        locations.push({ ...identity, ...location });
      }

      const count = await source.setLocations(locations);
      updated += count;
      shared += locations.length - count;

      if (items.length < FILE_LOCATION_BATCH_SIZE) {
        break;
      }
    }

    this.logger.log(`Assigned a storage location to ${updated} ${label}(s)`);
    if (invalid > 0 || shared > 0) {
      this.logger.warn(
        `Skipped ${invalid} ${label}(s) with an unusable path and ${shared} ${label}(s) whose path is shared with another file`,
      );
    }
  }

  @OnJob({ name: JobName.FileDelete, queue: QueueName.BackgroundTask })
  async handleDeleteFiles(job: JobOf<JobName.FileDelete>): Promise<JobStatus> {
    const { files, locations = [] } = job;

    // TODO: one job per file
    for (const file of files) {
      if (!file) {
        continue;
      }

      try {
        await this.storageRepository.unlink(file);
      } catch (error: any) {
        this.logger.warn('Unable to remove file from disk', error);
      }
    }

    for (const location of locations) {
      await this.storageBackendRepository.dropLocalCopy(location);
    }

    const [delayed, now] = partition(
      locations,
      ({ backendId }) => !job.immediate && !isBuiltinStorageBackend(backendId),
    );
    await this.registerDeletions(delayed);

    // never deleted while recorded: a file that is recorded again (or still) is not the one to delete
    const configured = now.filter(({ backendId }) => !isBuiltinStorageBackend(backendId));
    const recordedFiles = await this.storageDeletionRepository.getRecorded(configured);
    const recorded = new Set(recordedFiles.map(({ backendId, key }) => `${backendId}:${key}`));
    const unrecorded = now.filter(({ backendId, key }) => !recorded.has(`${backendId}:${key}`));
    for (const [backendId, keys] of Map.groupBy(unrecorded, ({ backendId }) => backendId)) {
      await this.deleteFromBackend(
        backendId,
        keys.map(({ key }) => key),
      );
    }

    return JobStatus.Success;
  }

  private async deleteFromBackend(backendId: string, keys: string[]) {
    try {
      const store = this.storageBackendRepository.getDeletionStore(backendId);
      for (const batch of chunk(keys, store.limits.maxDeleteBatch)) {
        const { failed } = await store.deleteMany(batch);
        for (const key of failed) {
          this.logger.warn(`Unable to remove ${key} from storage backend ${backendId}`);
        }
      }
    } catch (error: any) {
      this.logger.warn(`Unable to remove files from storage backend ${backendId}`, error);
    }
  }

  private async verifyReadAccess(folder: StorageFolder) {
    const { internalPath, externalPath } = this.getMountFilePaths(folder);
    try {
      await this.storageRepository.readFile(internalPath);
    } catch (error) {
      this.logger.error(`Failed to read (${internalPath}): ${error}`);
      throw new ImmichStartupError(`Failed to read: "${externalPath} (${internalPath}) - ${docsMessage}"`);
    }
  }

  private async createMountFile(folder: StorageFolder) {
    const { folderPath, internalPath, externalPath } = this.getMountFilePaths(folder);
    try {
      this.storageRepository.mkdirSync(folderPath);
      await this.storageRepository.createFile(internalPath, Buffer.from(Date.now().toString()));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        this.logger.warn('Found existing mount file, skipping creation');
        return;
      }
      this.logger.error(`Failed to create ${internalPath}: ${error}`);
      throw new ImmichStartupError(`Failed to create "${externalPath} - ${docsMessage}"`);
    }
  }

  private async verifyWriteAccess(folder: StorageFolder) {
    const { internalPath, externalPath } = this.getMountFilePaths(folder);
    try {
      await this.storageRepository.overwriteFile(internalPath, Buffer.from(Date.now().toString()));
    } catch (error) {
      this.logger.error(`Failed to write ${internalPath}: ${error}`);
      throw new ImmichStartupError(`Failed to write "${externalPath} - ${docsMessage}"`);
    }
  }

  private getMountFilePaths(folder: StorageFolder) {
    const folderPath = StorageCore.getBaseFolder(folder);
    const internalPath = join(folderPath, '.immich');
    const externalPath = `<UPLOAD_LOCATION>/${folder}/.immich`;

    return { folderPath, internalPath, externalPath };
  }
}
