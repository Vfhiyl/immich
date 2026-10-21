import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { JobStatus, StorageBackendDriver, StorageBackendRole } from 'src/enum.js';
import { EncryptedBlobStore } from 'src/repositories/encrypted-blob-store.js';
import { MasterKeys } from 'src/repositories/key-provider.js';
import { StorageBackupService } from 'src/services/storage-backup.service.js';
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
});
