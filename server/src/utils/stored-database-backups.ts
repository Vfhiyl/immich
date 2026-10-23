import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { StorageCore } from 'src/cores/storage.core.js';
import { StorageFolder } from 'src/enum.js';
import { BlobManifest, EncryptedBlobStore } from 'src/repositories/encrypted-blob-store.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { isValidDatabaseBackupName } from 'src/utils/database-backups.js';

/** What an object on the backend for backups says it is, in its encrypted manifest */
export const DATABASE_BACKUP_KIND = 'database-backup';

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
 * The database backups on a backend for backups, the newest first, each read from its own encrypted manifest: with
 * nothing but the backend and the master key, also when the database is gone. Objects that cannot be read (e.g.
 * encrypted with a master key that is not available) are passed to `onUnreadable` and left out.
 */
export const listStoredDatabaseBackups = async (
  store: EncryptedBlobStore,
  onUnreadable: (key: string, error: unknown) => void,
): Promise<StoredDatabaseBackup[]> => {
  const backups: StoredDatabaseBackup[] = [];
  for await (const { key } of store.list()) {
    let manifest: BlobManifest;
    let header: Buffer;
    try {
      ({ manifest, header } = await store.describe(key));
    } catch (error) {
      onUnreadable(key, error);
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
};

/**
 * Copy a stored backup into the backups folder, decrypted and verified, where it can be restored like any backup (as
 * `uploaded-<name>`, like a backup uploaded for a restore)
 */
export const fetchStoredDatabaseBackup = async (
  store: EncryptedBlobStore,
  backup: StoredDatabaseBackup,
  storageRepository: StorageRepository,
) => {
  const filename = `uploaded-${backup.filename}`;
  if (!isValidDatabaseBackupName(filename)) {
    throw new Error(`Invalid backup name: ${backup.filename}`);
  }
  const path = join(StorageCore.getBaseFolder(StorageFolder.Backups), filename);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const content = await store.get(backup.key, {
      encryption: backup.encryption,
      expect: { size: backup.size, sha1: backup.sha1 },
    });
    await pipeline(content, createWriteStream(temporary, { flags: 'wx' }));
    await storageRepository.rename(temporary, path);
  } finally {
    await storageRepository.unlink(temporary).catch(() => {});
  }
  return { filename };
};
