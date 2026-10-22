import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { JobStatus, StorageBackendDriver, StorageBackendRole, StorageCheckKind } from 'src/enum.js';
import { EncryptedBlobStore } from 'src/repositories/encrypted-blob-store.js';
import { MasterKeys } from 'src/repositories/key-provider.js';
import { StorageBackupService, databaseNameOf, withDatabase } from 'src/services/storage-backup.service.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const backupName = (day: number) =>
  `immich-db-backup-202610${String(day).padStart(2, '0')}T020000-v3.3.4-pg16.4.sql.gz`;

describe(StorageBackupService.name, () => {
  let sut: StorageBackupService;
  let mocks: ServiceMocks;
  let root: string;
  let keys: MasterKeys;

  const backupsFolder = () => join(root, 'media', 'backups');
  const configure = (keepLast = 14) =>
    mocks.storageBackend.configure(
      [
        {
          id: 'backups',
          driver: StorageBackendDriver.Local,
          role: StorageBackendRole.Backup,
          root: join(root, 'bucket'),
          encrypted: true,
        },
      ],
      keys,
      undefined,
      { keepLast },
    );
  const configureWithReplica = (keepLast = 14) =>
    mocks.storageBackend.configure(
      [
        {
          id: 'backups',
          driver: StorageBackendDriver.Local,
          role: StorageBackendRole.Backup,
          root: join(root, 'bucket'),
          encrypted: true,
        },
        {
          id: 'copy',
          driver: StorageBackendDriver.Local,
          role: StorageBackendRole.Replica,
          root: join(root, 'replica'),
          encrypted: true,
          replicaOf: [StorageBackendRole.Backup],
        },
      ],
      keys,
      undefined,
      { keepLast },
    );
  const replicaFolder = () => join(root, 'replica', 'backups');
  const writeBackups = async (...names: string[]) => {
    await fs.mkdir(backupsFolder(), { recursive: true });
    for (const name of names) {
      await fs.writeFile(join(backupsFolder(), name), `content of ${name}`);
    }
    mocks.storage.readdir.mockResolvedValue(await fs.readdir(backupsFolder()));
  };
  const storedNames = async () => {
    const { backups } = await sut.getStoredBackups();
    return backups.map(({ filename }) => filename);
  };

  beforeEach(async () => {
    ({ sut, mocks } = newTestService(StorageBackupService));
    root = await fs.mkdtemp(join(tmpdir(), 'immich-storage-backup-'));
    StorageCore.setMediaLocation(join(root, 'media'));
    keys = new MasterKeys([randomBytes(32)]);
    configure();
    mocks.storage.rename.mockImplementation((from, to) => fs.rename(from, to));
    mocks.storage.unlink.mockImplementation((path) => fs.rm(path));
  });

  afterEach(async () => {
    StorageCore.setMediaLocation('/data');
    await fs.rm(root, { recursive: true, force: true });
  });

  it('should do nothing without a storage backend for backups', async () => {
    mocks.storageBackend.configure([]);
    await expect(sut.handleStoreDatabaseBackups()).resolves.toBe(JobStatus.Skipped);
    await expect(sut.getStoredBackups()).rejects.toThrow('No storage backend for backups');
  });

  it('should store the routine backups, encrypted and described by themselves, the newest first', async () => {
    await writeBackups(backupName(1), backupName(2), 'restore-point-immich-db-backup.sql.gz', 'notes.txt');

    await expect(sut.handleStoreDatabaseBackups()).resolves.toBe(JobStatus.Success);

    await expect(storedNames()).resolves.toEqual([backupName(2), backupName(1)]);
    const objects = await fs.readdir(join(root, 'bucket'));
    expect(objects).toHaveLength(2);
    for (const object of objects) {
      expect(object).toMatch(/^[0-9a-f-]{36}$/);
      const content = await fs.readFile(join(root, 'bucket', object));
      expect(content.includes(Buffer.from('content of'))).toBe(false);
    }
    // described by the objects alone, which the master key opens
    const store = new EncryptedBlobStore(mocks.storageBackend.get('backups'), keys);
    const { manifest } = await store.describe(objects[0]);
    expect(manifest).toMatchObject({ kind: 'database-backup', keepLast: 14, filename: expect.any(String) });
  });

  it('should store each backup once', async () => {
    await writeBackups(backupName(1));
    await sut.handleStoreDatabaseBackups();
    await writeBackups(backupName(2));
    await sut.handleStoreDatabaseBackups();

    await expect(storedNames()).resolves.toEqual([backupName(2), backupName(1)]);
    await expect(fs.readdir(join(root, 'bucket'))).resolves.toHaveLength(2);
  });

  it('should keep as many backups as configured, deleting the oldest', async () => {
    configure(2);
    await writeBackups(backupName(1), backupName(2), backupName(3));

    await sut.handleStoreDatabaseBackups();

    await expect(storedNames()).resolves.toEqual([backupName(3), backupName(2)]);
  });

  it('should keep backups for as long as when they were taken, even if fewer are kept now', async () => {
    configure(3);
    await writeBackups(backupName(1), backupName(2), backupName(3));
    await sut.handleStoreDatabaseBackups();

    // fewer are kept from now on: the backups taken before still wait for three newer ones, the new ones for one
    configure(1);
    await writeBackups(backupName(4));
    await sut.handleStoreDatabaseBackups();
    await expect(storedNames()).resolves.toEqual([backupName(4), backupName(3), backupName(2)]);

    await writeBackups(backupName(5));
    await sut.handleStoreDatabaseBackups();
    await expect(storedNames()).resolves.toEqual([backupName(5), backupName(3)]);
  });

  it('should apply a larger number to backups taken before', async () => {
    configure(1);
    await writeBackups(backupName(1));
    await sut.handleStoreDatabaseBackups();

    configure(3);
    await writeBackups(backupName(2), backupName(3));
    await sut.handleStoreDatabaseBackups();

    await expect(storedNames()).resolves.toEqual([backupName(3), backupName(2), backupName(1)]);
  });

  describe('replicas', () => {
    it('should copy the backups to the folder of the backend on each replica, as they are stored', async () => {
      configureWithReplica();
      await writeBackups(backupName(1), backupName(2));

      await sut.handleStoreDatabaseBackups();

      const objects = await fs.readdir(join(root, 'bucket'));
      await expect(fs.readdir(replicaFolder()).then((keys) => keys.toSorted())).resolves.toEqual(objects.toSorted());
      for (const key of objects) {
        const stored = await fs.readFile(join(root, 'bucket', key));
        await expect(fs.readFile(join(replicaFolder(), key))).resolves.toEqual(stored);
      }
    });

    it('should copy what a replica is missing, and keep as many backups there', async () => {
      configureWithReplica(2);
      await writeBackups(backupName(1));
      await sut.handleStoreDatabaseBackups();
      await fs.rm(replicaFolder(), { recursive: true });

      await writeBackups(backupName(2), backupName(3));
      await sut.handleStoreDatabaseBackups();

      const store = mocks.storageBackend.getEncryptedReplicaStore('copy', 'backups');
      const names = [];
      for await (const { key } of store.list()) {
        const { manifest } = await store.describe(key);
        names.push(String(manifest.filename));
      }
      expect(names.toSorted((a, b) => a.localeCompare(b))).toEqual([backupName(2), backupName(3)]);
    });

    it('should keep storing backups when a replica fails', async () => {
      configureWithReplica();
      await fs.mkdir(join(root, 'replica'), { recursive: true });
      // a file where the folder of the backend should be
      await fs.writeFile(replicaFolder(), 'in the way');
      await writeBackups(backupName(1));

      await expect(sut.handleStoreDatabaseBackups()).resolves.toBe(JobStatus.Success);
      await expect(storedNames()).resolves.toEqual([backupName(1)]);
    });
  });

  it('should fetch a stored backup into the backups folder, decrypted, to restore it', async () => {
    await writeBackups(backupName(1));
    await sut.handleStoreDatabaseBackups();
    await fs.rm(join(backupsFolder(), backupName(1)));
    const {
      backups: [{ key }],
    } = await sut.getStoredBackups();

    await expect(sut.fetchStoredBackup(key)).resolves.toEqual({ filename: `uploaded-${backupName(1)}` });

    await expect(fs.readFile(join(backupsFolder(), `uploaded-${backupName(1)}`), 'utf8')).resolves.toBe(
      `content of ${backupName(1)}`,
    );
    await expect(fs.readdir(backupsFolder())).resolves.toEqual([`uploaded-${backupName(1)}`]);
  });

  it('should not fetch what is not a stored backup', async () => {
    await writeBackups(backupName(1));
    await sut.handleStoreDatabaseBackups();
    await expect(sut.fetchStoredBackup('00000000-0000-4000-8000-000000000000')).rejects.toThrow('not found');
  });

  describe('restore drill', () => {
    it('should connect to a database of its own on the same server', () => {
      const parts = {
        connectionType: 'parts' as const,
        host: 'database',
        port: 5432,
        username: 'postgres',
        password: 'secret',
        database: 'immich',
      };
      expect(withDatabase(parts, 'immich_restore_drill')).toEqual({ ...parts, database: 'immich_restore_drill' });
      expect(databaseNameOf(parts)).toBe('immich');

      const url = {
        connectionType: 'url' as const,
        url: 'postgres://postgres:secret@database:5432/immich?sslmode=require',
      };
      expect(withDatabase(url, 'immich_restore_drill')).toEqual({
        connectionType: 'url',
        url: 'postgres://postgres:secret@database:5432/immich_restore_drill?sslmode=require',
      });
      expect(databaseNameOf(url)).toBe('immich');
    });

    it('should not run without a backend for backups', async () => {
      mocks.storageBackend.configure([]);

      await expect(sut.handleRestoreDrill()).resolves.toBe(JobStatus.Skipped);
      expect(mocks.storageCheck.startRun).not.toHaveBeenCalled();
    });

    it('should only run every three months, unless started', async () => {
      configure();
      mocks.storageCheck.getLastRun.mockResolvedValue({
        startedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      } as never);

      await expect(sut.handleRestoreDrill()).resolves.toBe(JobStatus.Skipped);
      expect(mocks.storageCheck.getLastRun).toHaveBeenCalledWith(StorageCheckKind.RestoreDrill);
      expect(mocks.storageCheck.startRun).not.toHaveBeenCalled();
    });

    it('should report a drill without a backup to restore as failed, and tell the administrator', async () => {
      configure();
      mocks.storageCheck.getLastRun.mockResolvedValue(undefined);
      mocks.storageCheck.startRun.mockResolvedValue({ id: 'run-id' } as never);
      mocks.storageCheck.finishRun.mockResolvedValue();
      mocks.database.dropDatabase.mockResolvedValue();
      mocks.user.getAdmin.mockResolvedValue({ id: 'admin-id' } as never);
      mocks.notification.create.mockResolvedValue({ id: 'notification-id', createdAt: new Date() } as never);

      await expect(sut.handleRestoreDrill({ force: true })).resolves.toBe(JobStatus.Failed);

      expect(mocks.storageCheck.finishRun).toHaveBeenCalledWith(
        'run-id',
        'failed',
        expect.objectContaining({ stoppedBecause: 'There is no stored database backup to restore' }),
      );
      expect(mocks.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'The restore drill failed' }),
      );
      // nothing is left behind
      expect(mocks.database.dropDatabase).toHaveBeenCalledWith('immich_restore_drill');
      expect(mocks.database.createDatabase).not.toHaveBeenCalled();
    });
  });
});
