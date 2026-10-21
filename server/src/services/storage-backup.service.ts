import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnJob } from 'src/decorators.js';
import { StoredDatabaseBackupListResponseDto } from 'src/dtos/storage-backup.dto.js';
import { JobName, JobStatus, QueueName, StorageBackendRole, StorageFolder } from 'src/enum.js';
import { BlobManifest } from 'src/repositories/encrypted-blob-store.js';
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

    await this.deleteOldBackups(backendId, keepLast);
    return JobStatus.Success;
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
  private async listStoredBackups(backendId: string): Promise<StoredDatabaseBackup[]> {
    const store = this.storageBackendRepository.getEncryptedStore(backendId);
    const backups: StoredDatabaseBackup[] = [];
    for await (const { key } of store.list()) {
      let manifest: BlobManifest;
      let header: Buffer;
      try {
        ({ manifest, header } = await store.describe(key));
      } catch (error) {
        this.logger.warn(`Unable to read what ${key} on storage backend ${backendId} is: ${error}`);
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
   * is more: a larger number applies to old backups too, a smaller one does not shorten their time
   */
  private async deleteOldBackups(backendId: string, keepLast: number) {
    const backups = await this.listStoredBackups(backendId);
    const old = backups.filter((backup, newer) => newer >= Math.max(backup.keepLast, keepLast));
    if (old.length === 0) {
      return;
    }

    // a bucket with object lock may refuse, which is fine: the backup is deleted on a later run
    const { failed } = await this.storageBackendRepository
      .getDeletionStore(backendId)
      .deleteMany(old.map(({ key }) => key));
    for (const backup of old) {
      if (failed.includes(backup.key)) {
        this.logger.warn(
          `Unable to delete the old database backup ${backup.filename} from storage backend ${backendId}`,
        );
      } else {
        this.logger.log(`Deleted the old database backup ${backup.filename} from storage backend ${backendId}`);
      }
    }
  }
}
