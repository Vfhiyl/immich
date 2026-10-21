import { Injectable } from '@nestjs/common';
import { join } from 'node:path';
import type { JobOf, SystemFlags } from 'src/types.js';
import { ErrorMessages } from 'src/constants.js';
import { StorageCore, StorageLocation } from 'src/cores/storage.core.js';
import { OnEvent, OnJob } from 'src/decorators.js';
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
import { PersonId } from 'src/repositories/person.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { ImmichStartupError } from 'src/utils/misc.js';

/** Number of asset files given a storage location per database round trip */
const FILE_LOCATION_BATCH_SIZE = 5000;

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
    const { files } = job;

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

    return JobStatus.Success;
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
