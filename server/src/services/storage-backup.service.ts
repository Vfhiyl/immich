import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { partition } from 'lodash-es';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnJob } from 'src/decorators.js';
import { StoredDatabaseBackupListResponseDto } from 'src/dtos/storage-backup.dto.js';
import { JobName, JobStatus, QueueName, StorageBackendRole, StorageFolder } from 'src/enum.js';
import { BlobStore } from 'src/repositories/blob-store.js';
import { BlobManifest, EncryptedBlobStore } from 'src/repositories/encrypted-blob-store.js';
import { BaseService } from 'src/services/base.service.js';
import { isValidDatabaseBackupName, isValidDatabaseRoutineBackupName } from 'src/utils/database-backups.js';

/** What an object on the backend for backups says it is, in its encrypted manifest */
const DATABASE_BACKUP_KIND = 'database-backup';

export interface StoredDatabaseBackup {
  key: string;
  filename: string;
  size: number;
  sha1: Buffer;
  encryption: Buffer;
  createdAt: string;
  /** How many newer backups had to exist before this one could go, when it was taken */
  keepLast: number;
}

/**
 * Database backups on the backend for backups. The routine backups Immich writes to its backups folder are stored
 * there, encrypted, under random keys; each one describes itself in its encrypted manifest, so that backups can be
 * listed and read with nothing but the backend and the master key, also when the database is gone.
 */
@Injectable()
export class StorageBackupService extends BaseService {
  @OnJob({ name: JobName.DatabaseBackupStore, queue: QueueName.BackupDatabase })
  async handleStoreDatabaseBackups(): Promise<JobStatus> {
    const backendId = this.storageBackendRepository.getBackendFor(StorageBackendRole.Backup);
    if (!backendId) {
      return JobStatus.Skipped;
    }

    const stored = await this.listStoredBackups(backendId);
    const storedNames = new Set(stored.map(({ filename }) => filename));
    const folder = StorageCore.getBaseFolder(StorageFolder.Backups);
    const files = await this.storageRepository.readdir(folder);
    const keepLast = this.storageBackendRepository.getDatabaseBackupsKeepLast();
    const store = this.storageBackendRepository.getWriteStore(backendId);

    for (const filename of files) {
      if (!isValidDatabaseRoutineBackupName(filename) || storedNames.has(filename)) {
        continue;
      }
      const createdAt = new Date().toISOString();
      const manifest = { kind: DATABASE_BACKUP_KIND, filename, keepLast, createdAt };
      const key = randomUUID();
      const { size } = await store.put(key, createReadStream(join(folder, filename)), { manifest });
      this.logger.log(`Stored database backup ${filename} (${size} bytes) on storage backend ${backendId}`);
    }

    const remaining = await this.deleteOldBackups(
      await this.listStoredBackups(backendId),
      keepLast,
      this.storageBackendRepository.getDeletionStore(backendId),
      `storage backend ${backendId}`,
    );
    await this.copyToReplicas(backendId, remaining, keepLast);
    return JobStatus.Success;
  }

  /**
   * Copy the backups to each replica of the backend for backups, as they are stored, and keep as many there: a replica
   * applies the same rules to what it holds, which may be more than the backend has, e.g. after it refused a deletion
   */
  private async copyToReplicas(backendId: string, backups: StoredDatabaseBackup[], keepLast: number) {
    const replicas = this.storageBackendRepository
      .getReplicaSources()
      .filter(({ role }) => role === StorageBackendRole.Backup);
    const source = this.storageBackendRepository.get(backendId);
    for (const { replicaBackendId } of replicas) {
      try {
        const replica = this.storageBackendRepository.getReplicaStore(replicaBackendId, backendId);
        const copied = new Set<string>();
        for await (const { key } of replica.list()) {
          copied.add(key);
        }
        for (const backup of backups) {
          if (copied.has(backup.key)) {
            continue;
          }
          const stat = await source.head(backup.key);
          if (!stat) {
            throw new Error(`${backendId}:${backup.key} was not found`);
          }
          await replica.put(backup.key, await source.get(backup.key, { expect: { size: stat.size } }), {
            sizeHint: stat.size,
          });
          const written = await replica.head(backup.key);
          if (written?.size !== stat.size) {
            throw new Error(`The replica holds ${written ? written.size : 'no'} bytes of ${stat.size}`);
          }
          this.logger.log(`Copied database backup ${backup.filename} to replica ${replicaBackendId}`);
        }

        await this.deleteOldBackups(
          await this.listBackups(this.storageBackendRepository.getEncryptedReplicaStore(replicaBackendId, backendId)),
          keepLast,
          this.storageBackendRepository.getReplicaStore(replicaBackendId, backendId, { deletion: true }),
          `replica ${replicaBackendId}`,
        );
      } catch (error) {
        // tried again with the next backup
        this.logger.error(`Unable to copy database backups to replica ${replicaBackendId}: ${error}`);
      }
    }
  }

  async getStoredBackups(): Promise<StoredDatabaseBackupListResponseDto> {
    const backups = await this.listStoredBackups(this.requireBackupBackend());
    return {
      backups: backups.map(({ key, filename, size, createdAt }) => ({ key, filename, size, createdAt })),
    };
  }

  /** Copy a stored backup into the backups folder, decrypted and verified, where it can be restored like any backup */
  async fetchStoredBackup(key: string) {
    const backendId = this.requireBackupBackend();
    const backups = await this.listStoredBackups(backendId);
    const backup = backups.find((backup) => backup.key === key);
    if (!backup) {
      throw new NotFoundException('Stored database backup not found');
    }

    const filename = `uploaded-${backup.filename}`;
    if (!isValidDatabaseBackupName(filename)) {
      throw new BadRequestException('Invalid backup name!');
    }
    const path = join(StorageCore.getBaseFolder(StorageFolder.Backups), filename);
    const temporary = `${path}.${randomUUID()}.tmp`;
    const store = this.storageBackendRepository.getWriteStore(backendId);
    try {
      const content = await store.get(key, {
        encryption: backup.encryption,
        expect: { size: backup.size, sha1: backup.sha1 },
      });
      await pipeline(content, createWriteStream(temporary, { flags: 'wx' }));
      await this.storageRepository.rename(temporary, path);
    } finally {
      await this.storageRepository.unlink(temporary).catch(() => {});
    }
    return { filename };
  }

  private requireBackupBackend() {
    const backendId = this.storageBackendRepository.getBackendFor(StorageBackendRole.Backup);
    if (!backendId) {
      throw new BadRequestException('No storage backend for backups is configured');
    }
    return backendId;
  }

  /** The backups on the backend, the newest first, each read from its own trailer */
  private listStoredBackups(backendId: string): Promise<StoredDatabaseBackup[]> {
    return this.listBackups(this.storageBackendRepository.getEncryptedStore(backendId));
  }

  private async listBackups(store: EncryptedBlobStore): Promise<StoredDatabaseBackup[]> {
    const backups: StoredDatabaseBackup[] = [];
    for await (const { key } of store.list()) {
      let manifest: BlobManifest;
      let header: Buffer;
      try {
        ({ manifest, header } = await store.describe(key));
      } catch (error) {
        this.logger.warn(`Unable to read what the stored object ${key} is: ${error}`);
        continue;
      }
      if (manifest.kind !== DATABASE_BACKUP_KIND || typeof manifest.filename !== 'string') {
        continue;
      }
      backups.push({
        key,
        filename: manifest.filename,
        size: manifest.size,
        sha1: Buffer.from(manifest.sha1, 'hex'),
        encryption: header,
        createdAt: String(manifest.createdAt ?? ''),
        keepLast: Number(manifest.keepLast) || 0,
      });
    }
    // routine backups are named after when they were taken
    return backups.toSorted((a, b) => b.filename.localeCompare(a.filename));
  }

  /**
   * A backup goes once more newer backups exist than it had to wait for when it was taken, or than are kept now if that
   * is more: a larger number applies to old backups too, a smaller one does not shorten their time. Returns the
   * backups that are kept.
   */
  private async deleteOldBackups(
    backups: StoredDatabaseBackup[],
    keepLast: number,
    deletionStore: BlobStore,
    where: string,
  ): Promise<StoredDatabaseBackup[]> {
    const [old, kept] = partition(backups, (backup) => backups.indexOf(backup) >= Math.max(backup.keepLast, keepLast));
    if (old.length === 0) {
      return kept;
    }

    // a bucket with object lock may refuse, which is fine: the backup is deleted on a later run
    const { failed } = await deletionStore.deleteMany(old.map(({ key }) => key));
    for (const backup of old) {
      if (failed.includes(backup.key)) {
        this.logger.warn(`Unable to delete the old database backup ${backup.filename} from ${where}`);
      } else {
        this.logger.log(`Deleted the old database backup ${backup.filename} from ${where}`);
      }
    }
    return kept;
  }
}
