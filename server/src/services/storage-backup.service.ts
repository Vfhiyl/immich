import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { partition } from 'lodash-es';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import type { DatabaseConnectionParams } from '@immich/sql-tools';
import type { IStorageCheckJob } from 'src/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnJob } from 'src/decorators.js';
import { mapNotification } from 'src/dtos/notification.dto.js';
import { StoredDatabaseBackupListResponseDto } from 'src/dtos/storage-backup.dto.js';
import {
  JobName,
  JobStatus,
  NotificationLevel,
  NotificationType,
  QueueName,
  StorageBackendRole,
  StorageCheckKind,
  StorageCheckStatus,
  StorageFolder,
} from 'src/enum.js';
import { BlobStore } from 'src/repositories/blob-store.js';
import { BlobManifest, EncryptedBlobStore } from 'src/repositories/encrypted-blob-store.js';
import { VerifiableFile } from 'src/repositories/storage-check.repository.js';
import { DB } from 'src/schema/index.js';
import { StorageCheckStats } from 'src/schema/tables/storage-check.table.js';
import { BaseService } from 'src/services/base.service.js';
import { DatabaseBackupService, createSqlOwnerTransformStream } from 'src/services/database-backup.service.js';
import { StorageCheckService } from 'src/services/storage-check.service.js';
import { isValidDatabaseBackupName, isValidDatabaseRoutineBackupName } from 'src/utils/database-backups.js';
import { getKyselyConfig } from 'src/utils/database.js';

/** What an object on the backend for backups says it is, in its encrypted manifest */
const DATABASE_BACKUP_KIND = 'database-backup';

/** A restore drill runs every three months, and when an administrator starts one */
const RESTORE_DRILL_INTERVAL_MS = 90 * 24 * 60 * 60 * 1000;
/** Originals the restored backup records that are read back */
const RESTORE_DRILL_SAMPLE = 20;

/** The connection to another database of the same server */
export const withDatabase = (connection: DatabaseConnectionParams, database: string): DatabaseConnectionParams => {
  if (connection.connectionType !== 'url') {
    return { ...connection, database };
  }
  if (!URL.canParse(connection.url)) {
    throw new Error('The database URL cannot be read to connect to another database');
  }
  const url = new URL(connection.url);
  url.pathname = `/${encodeURIComponent(database)}`;
  return { ...connection, url: url.href };
};

/** The name of the database of a connection */
export const databaseNameOf = (connection: DatabaseConnectionParams) =>
  connection.connectionType === 'url'
    ? decodeURIComponent(new URL(connection.url).pathname.slice(1)) || 'postgres'
    : connection.database;

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

  /**
   * Restore the latest stored backup into a database of its own on the same server, as a disaster would need it (from
   * the backend for backups, with the master key), check that it holds what Immich needs, and read back a sample of the
   * originals it records: a backup is only worth something if it can be restored, and the files it records are there.
   * The database is dropped afterwards; Immich's own is not touched.
   */
  @OnJob({ name: JobName.StorageRestoreDrill, queue: QueueName.BackupDatabase })
  async handleRestoreDrill({ force }: IStorageCheckJob = {}): Promise<JobStatus> {
    const backendId = this.storageBackendRepository.getBackendFor(StorageBackendRole.Backup);
    if (!backendId) {
      return JobStatus.Skipped;
    }
    const last = await this.storageCheckRepository.getLastRun(StorageCheckKind.RestoreDrill);
    if (!force && last && Date.now() - new Date(last.startedAt).getTime() < RESTORE_DRILL_INTERVAL_MS) {
      return JobStatus.Skipped;
    }

    const run = await this.storageCheckRepository.startRun(StorageCheckKind.RestoreDrill, [backendId]);
    const stats: StorageCheckStats = { backends: [backendId], checked: 0, bytes: 0, newIssues: 0, openIssues: 0 };
    const live = this.configRepository.getEnv().database.config;
    const name = `${databaseNameOf(live)}_restore_drill`.slice(0, 63);
    try {
      const [backup] = await this.listStoredBackups(backendId);
      if (!backup) {
        throw new Error('There is no stored database backup to restore');
      }
      stats.restoredBackup = backup.filename;
      const connection = withDatabase(live, name);

      await this.databaseRepository.dropDatabase(name);
      await this.databaseRepository.createDatabase(name);
      await this.restoreInto(backendId, backup, connection);

      const restored = new Kysely<DB>(getKyselyConfig(connection));
      let sample: VerifiableFile[];
      try {
        const counts = await restored
          .selectNoFrom((eb) => [
            eb
              .selectFrom('user')
              .select((eb) => eb.fn.countAll<string>().as('count'))
              .as('users'),
            eb
              .selectFrom('asset')
              .select((eb) => eb.fn.countAll<string>().as('count'))
              .as('assets'),
          ])
          .executeTakeFirstOrThrow();
        if (Number(counts.users) === 0) {
          throw new Error('The restored backup has no users');
        }
        stats.restoredAssets = Number(counts.assets);
        sample = (await restored
          .selectFrom('asset_original_file')
          .select(['backendId', 'key', 'size', 'checksum', 'encryption'])
          .where('backendId', 'is not', null)
          .where('key', 'is not', null)
          .orderBy(sql`random()`)
          .limit(RESTORE_DRILL_SAMPLE)
          .execute()) as VerifiableFile[];
      } finally {
        await restored.destroy();
      }

      // the files the restored records point to, read back where they are now
      const checks = BaseService.create(StorageCheckService, this);
      for (const file of sample) {
        await checks.verifyFile(file, stats);
      }
    } catch (error) {
      this.logger.error(`Restore drill failed: ${error}`);
      await this.storageCheckRepository.finishRun(run.id, StorageCheckStatus.Failed, {
        ...stats,
        stoppedBecause: error instanceof Error ? error.message : String(error),
      });
      await this.notifyAdmin(error);
      return JobStatus.Failed;
    } finally {
      try {
        await this.databaseRepository.dropDatabase(name);
      } catch (error) {
        this.logger.warn(`Unable to drop the database of the restore drill (${name}): ${error}`);
      }
    }

    stats.openIssues = await this.storageCheckRepository.countOpenIssues();
    await this.storageCheckRepository.finishRun(
      run.id,
      stats.newIssues > 0 ? StorageCheckStatus.Issues : StorageCheckStatus.Ok,
      stats,
    );
    return JobStatus.Success;
  }

  /** Read a stored backup (decrypted and verified as it is read) into psql, connected to `connection` */
  private async restoreInto(backendId: string, backup: StoredDatabaseBackup, connection: DatabaseConnectionParams) {
    const backups = new DatabaseBackupService(
      this.logger,
      this.storageRepository,
      this.configRepository,
      this.systemMetadataRepository,
      this.processRepository,
      this.databaseRepository,
      this.userRepository,
      this.cronRepository,
      this.jobRepository,
      // only for restoring Immich's own database
      undefined as never,
    );
    const { bin, args, databaseUsername, databasePassword } = await backups.buildPostgresLaunchArguments('psql', {
      singleTransaction: true,
      connection,
    });
    const content = await this.storageBackendRepository
      .getWriteStore(backendId)
      .get(backup.key, { encryption: backup.encryption, expect: { size: backup.size, sha1: backup.sha1 } });
    const psql = this.processRepository.spawnDuplexStream(bin, args, {
      env: { PATH: process.env.PATH, PGPASSWORD: databasePassword },
    });
    // psql echoes what it runs
    const discard = new Writable({ write: (_chunk, _encoding, done) => done() });
    await (backup.filename.endsWith('.gz')
      ? pipeline(content, createGunzip(), createSqlOwnerTransformStream(databaseUsername), psql, discard)
      : pipeline(content, createSqlOwnerTransformStream(databaseUsername), psql, discard));
  }

  private async notifyAdmin(error: unknown) {
    const admin = await this.userRepository.getAdmin();
    if (!admin) {
      return;
    }
    const notification = await this.notificationRepository.create({
      userId: admin.id,
      type: NotificationType.SystemMessage,
      level: NotificationLevel.Error,
      title: 'The restore drill failed',
      description: `The latest stored database backup could not be restored: ${error instanceof Error ? error.message : String(error)}. See the storage page.`,
    });
    this.websocketRepository.clientSend('on_notification', admin.id, mapNotification(notification));
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
