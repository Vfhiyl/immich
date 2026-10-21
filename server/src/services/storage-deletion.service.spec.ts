import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JobName,
  JobStatus,
  NotificationLevel,
  NotificationType,
  StorageBackendDriver,
  StorageBackendRole,
  SystemMetadataKey,
} from 'src/enum.js';
import { StorageDeletionService } from 'src/services/storage-deletion.service.js';
import { factory } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const due = (id: string, key: string, backendId = 'originals') => ({
  id,
  backendId,
  key,
  notBefore: new Date(),
  isOriginal: true,
  createdAt: new Date(),
  attempts: 0,
  lastError: null,
  ownerId: null,
  originalFileName: null,
  originalPath: null,
  fileCreatedAt: null,
  size: null,
  checksum: null,
  encryption: null,
});

const original = () => ({ ...due('id', 'key'), originalFileName: 'IMG_1.jpg' });

describe(StorageDeletionService.name, () => {
  let sut: StorageDeletionService;
  let mocks: ServiceMocks;
  let root: string;

  beforeEach(async () => {
    ({ sut, mocks } = newTestService(StorageDeletionService));
    root = await fs.mkdtemp(join(tmpdir(), 'immich-storage-deletion-'));
    mocks.storageBackend.configure(
      [
        {
          id: 'originals',
          driver: StorageBackendDriver.Local,
          role: StorageBackendRole.Originals,
          root,
          encrypted: false,
        },
      ],
      undefined,
      { delayDays: 360 },
    );
    mocks.systemMetadata.get.mockResolvedValue(null);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('should run when the server starts', async () => {
    await sut.onBootstrap();
    expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.StorageDeletionRun });
  });

  describe('handleStorageDeletionRun', () => {
    it('should delete the files whose time has come and their registrations', async () => {
      await fs.writeFile(join(root, 'a'), 'a');
      await fs.writeFile(join(root, 'b'), 'b');
      mocks.storageDeletion.getDue.mockResolvedValueOnce([due('1', 'a'), due('2', 'b')]).mockResolvedValue([]);

      await expect(sut.handleStorageDeletionRun()).resolves.toBe(JobStatus.Success);

      await expect(fs.readdir(root)).resolves.toEqual([]);
      expect(mocks.storageDeletion.remove).toHaveBeenCalledWith(['1', '2']);
      expect(mocks.storageDeletion.getDue).toHaveBeenCalledWith({
        now: expect.any(Date),
        originalsDelayDays: 360,
        limit: 1000,
      });
    });

    it('should never delete a file that is recorded again, and drop its registration', async () => {
      await fs.writeFile(join(root, 'a'), 'a');
      mocks.storageDeletion.getDue.mockResolvedValueOnce([due('1', 'a')]).mockResolvedValue([]);
      mocks.storageDeletion.getRecorded.mockResolvedValue([{ backendId: 'originals', key: 'a' }]);

      await sut.handleStorageDeletionRun();

      await expect(fs.readdir(root)).resolves.toEqual(['a']);
      expect(mocks.storageDeletion.remove).toHaveBeenCalledWith(['1']);
      expect(mocks.logger.warn).toHaveBeenCalledWith('Not deleting originals:a, which is recorded again');
    });

    it('should keep the registration of a file that could not be deleted, to try again later', async () => {
      await fs.mkdir(join(root, 'directory'));
      await fs.writeFile(join(root, 'a'), 'a');
      mocks.storageDeletion.getDue.mockResolvedValueOnce([due('1', 'directory'), due('2', 'a')]).mockResolvedValue([]);

      await sut.handleStorageDeletionRun();

      expect(mocks.storageDeletion.remove).toHaveBeenCalledWith(['2']);
      expect(mocks.storageDeletion.recordFailure).toHaveBeenCalledWith(
        ['1'],
        'The storage backend did not delete the file',
        expect.any(Date),
      );
    });

    it('should keep the registrations of a backend that is not available', async () => {
      mocks.storageDeletion.getDue.mockResolvedValueOnce([due('1', 'a', 'gone')]).mockResolvedValue([]);

      await expect(sut.handleStorageDeletionRun()).resolves.toBe(JobStatus.Success);

      expect(mocks.storageDeletion.recordFailure).toHaveBeenCalledWith(
        ['1'],
        expect.stringContaining('Unknown storage backend: gone'),
        expect.any(Date),
      );
      expect(mocks.storageDeletion.remove).not.toHaveBeenCalledWith(['1']);
    });

    it('should also remove the local copies of deleted files', async () => {
      await fs.writeFile(join(root, 'a'), 'a');
      mocks.storageDeletion.getDue.mockResolvedValueOnce([due('1', 'a')]).mockResolvedValue([]);

      await sut.handleStorageDeletionRun();

      expect(mocks.storageBackend.dropLocalCopy).toHaveBeenCalledWith(expect.objectContaining({ key: 'a' }));
    });

    it('should stop after a limited number of files per run', async () => {
      // files of a backend that is not available, which fail fast
      mocks.storageDeletion.getDue.mockImplementation(({ limit }) =>
        Promise.resolve(Array.from({ length: limit }, (_, index) => due(String(index), 'a', 'gone'))),
      );

      await sut.handleStorageDeletionRun();

      expect(mocks.storageDeletion.getDue).toHaveBeenCalledTimes(100);
    });

    it('should pause and notify the administrator when many more originals are due than usual', async () => {
      mocks.storageDeletion.countStoredOriginals.mockResolvedValue(10_000);
      mocks.storageDeletion.countDueOriginals.mockResolvedValue(500);
      mocks.user.getAdmin.mockResolvedValue({ id: 'admin-id' } as never);
      mocks.notification.create.mockResolvedValue({ id: 'notification-id' } as never);

      await expect(sut.handleStorageDeletionRun()).resolves.toBe(JobStatus.Skipped);

      // 2% of the 10,500 originals is 210
      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.StorageDeletionState, {
        pausedAt: expect.any(String),
        dueOriginals: 500,
        limit: 210,
      });
      expect(mocks.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'admin-id',
          type: NotificationType.SystemMessage,
          level: NotificationLevel.Error,
          description: expect.stringContaining('500 deleted originals are due'),
        }),
      );
      expect(mocks.storageDeletion.getDue).not.toHaveBeenCalled();
    });

    it('should delete without asking up to the minimum, however small the library', async () => {
      mocks.storageDeletion.countStoredOriginals.mockResolvedValue(10);
      mocks.storageDeletion.countDueOriginals.mockResolvedValue(100);

      await expect(sut.handleStorageDeletionRun()).resolves.toBe(JobStatus.Success);

      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('should not delete anything while paused', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ pausedAt: '2026-10-21T00:00:00.000Z' });

      await expect(sut.handleStorageDeletionRun()).resolves.toBe(JobStatus.Skipped);

      expect(mocks.storageDeletion.getDue).not.toHaveBeenCalled();
    });

    it('should apply a longer delay to originals that were registered with a shorter one', async () => {
      mocks.storageBackend.configure(
        [
          {
            id: 'originals',
            driver: StorageBackendDriver.Local,
            role: StorageBackendRole.Originals,
            root,
            encrypted: false,
          },
        ],
        undefined,
        { delayDays: 720 },
      );

      await sut.handleStorageDeletionRun();

      expect(mocks.storageDeletion.countDueOriginals).toHaveBeenCalledWith({
        now: expect.any(Date),
        originalsDelayDays: 720,
      });
      expect(mocks.storageDeletion.getDue).toHaveBeenCalledWith(expect.objectContaining({ originalsDelayDays: 720 }));
    });
  });

  describe('approval after a pause', () => {
    it('should delete what an administrator approved, and need a new approval once amounts are usual again', async () => {
      mocks.storageDeletion.countStoredOriginals.mockResolvedValue(10_000);
      mocks.systemMetadata.get.mockResolvedValue({ approvedDueOriginals: 500 });
      mocks.storageDeletion.countDueOriginals.mockResolvedValueOnce(500).mockResolvedValueOnce(50);

      await expect(sut.handleStorageDeletionRun()).resolves.toBe(JobStatus.Success);
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();

      await expect(sut.handleStorageDeletionRun()).resolves.toBe(JobStatus.Success);
      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.StorageDeletionState, {});
    });

    it('should pause again for more than was approved', async () => {
      mocks.storageDeletion.countStoredOriginals.mockResolvedValue(10_000);
      mocks.systemMetadata.get.mockResolvedValue({ approvedDueOriginals: 500 });
      mocks.storageDeletion.countDueOriginals.mockResolvedValue(800);

      await expect(sut.handleStorageDeletionRun()).resolves.toBe(JobStatus.Skipped);
      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(
        SystemMetadataKey.StorageDeletionState,
        expect.objectContaining({ pausedAt: expect.any(String), dueOriginals: 800 }),
      );
    });
  });

  describe('getStatus', () => {
    it('should report a pause and what is pending', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        pausedAt: '2026-10-21T00:00:00.000Z',
        dueOriginals: 500,
        limit: 210,
      });
      mocks.storageDeletion.countPending.mockResolvedValue({ originals: 600, files: 2000 });

      await expect(sut.getStatus()).resolves.toEqual({
        isPaused: true,
        pausedAt: '2026-10-21T00:00:00.000Z',
        dueOriginals: 500,
        limit: 210,
        pendingOriginals: 600,
        pendingFiles: 2000,
        delayDays: 360,
      });
    });

    it('should report no pause', async () => {
      await expect(sut.getStatus()).resolves.toEqual(
        expect.objectContaining({ isPaused: false, pausedAt: undefined, pendingOriginals: 0 }),
      );
    });
  });

  describe('resume', () => {
    it('should approve what was due and delete it right away', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        pausedAt: '2026-10-21T00:00:00.000Z',
        dueOriginals: 500,
        limit: 210,
      });

      await sut.resume(factory.auth({ user: { isAdmin: true } }));

      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.StorageDeletionState, {
        approvedDueOriginals: 500,
      });
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.StorageDeletionRun });
    });

    it('should refuse when deleting is not paused', async () => {
      await expect(sut.resume(factory.auth())).rejects.toThrow('not paused');
    });
  });

  describe('listOriginals', () => {
    it('should list deleted originals with when they will be deleted, a page at a time', async () => {
      const deletedAt = new Date('2026-01-01T00:00:00.000Z');
      const rows = ['a', 'b', 'c'].map((key, index) => ({
        ...due(`id-${index}`, key),
        createdAt: deletedAt,
        // registered with a 30 day delay, before the configured 360 days
        notBefore: new Date('2026-01-31T00:00:00.000Z'),
        ownerId: 'owner-id',
        originalFileName: `${key}.jpg`,
        size: 10,
      }));
      mocks.storageDeletion.listOriginals.mockResolvedValue(rows);

      const page = await sut.listOriginals({ limit: 2 });

      expect(mocks.storageDeletion.listOriginals).toHaveBeenCalledWith({
        ownerId: undefined,
        after: undefined,
        limit: 3,
      });
      expect(page.items).toEqual([
        expect.objectContaining({
          id: 'id-0',
          originalFileName: 'a.jpg',
          size: 10,
          deletedAt: deletedAt.toISOString(),
          deleteAfter: expect.stringMatching(/^2026-12-27T/),
        }),
        expect.objectContaining({ id: 'id-1' }),
      ]);
      expect(page.nextCursor).toBeDefined();

      await sut.listOriginals({ limit: 2, cursor: page.nextCursor });
      expect(mocks.storageDeletion.listOriginals).toHaveBeenLastCalledWith({
        ownerId: undefined,
        after: { createdAt: deletedAt, id: 'id-1' },
        limit: 3,
      });
    });

    it('should reject an invalid cursor', async () => {
      await expect(sut.listOriginals({ cursor: 'nonsense' })).rejects.toThrow('Invalid cursor');
    });
  });

  describe('getOriginalFile', () => {
    it('should send the deleted original under its original name', async () => {
      mocks.storageDeletion.get.mockResolvedValue({
        ...due('id', 'key'),
        originalFileName: 'IMG_1.jpg',
        originalPath: '/data/upload/IMG_1.jpg',
      });

      await expect(sut.getOriginalFile('id')).resolves.toEqual(
        expect.objectContaining({ fileName: 'IMG_1.jpg', contentType: 'image/jpeg', path: join(root, 'key') }),
      );
    });

    it('should not find a derived file or an unknown deletion', async () => {
      mocks.storageDeletion.get.mockResolvedValue({ ...due('id', 'key'), isOriginal: false });
      await expect(sut.getOriginalFile('id')).rejects.toThrow('Deleted original not found');
      mocks.storageDeletion.get.mockResolvedValue(undefined);
      await expect(sut.getOriginalFile('id')).rejects.toThrow('Deleted original not found');
    });
  });

  describe('purgeOriginal', () => {
    const auth = factory.auth({ user: { isAdmin: true } });

    beforeEach(() => {
      mocks.user.getForChangePassword.mockResolvedValue({ id: auth.user.id, password: 'hash' });
    });

    it('should delete the original now, after the administrator confirmed their password', async () => {
      await fs.writeFile(join(root, 'key'), 'original');
      mocks.storageDeletion.get.mockResolvedValue(original());
      mocks.crypto.compareBcrypt.mockReturnValue(true);

      await sut.purgeOriginal(auth, 'id', { password: 'secret' });

      expect(mocks.crypto.compareBcrypt).toHaveBeenCalledWith('secret', 'hash');
      await expect(fs.readdir(root)).resolves.toEqual([]);
      expect(mocks.storageDeletion.remove).toHaveBeenCalledWith(['id']);
    });

    it('should refuse a wrong password', async () => {
      await fs.writeFile(join(root, 'key'), 'original');
      mocks.storageDeletion.get.mockResolvedValue(original());
      mocks.crypto.compareBcrypt.mockReturnValue(false);

      await expect(sut.purgeOriginal(auth, 'id', { password: 'wrong' })).rejects.toThrow('Wrong password');
      await expect(fs.readdir(root)).resolves.toEqual(['key']);
    });

    it('should refuse for an administrator without a password', async () => {
      mocks.user.getForChangePassword.mockResolvedValue({ id: auth.user.id, password: '' });

      await expect(sut.purgeOriginal(auth, 'id', { password: 'anything' })).rejects.toThrow('Wrong password');
    });

    it('should not delete an original that is in use again', async () => {
      await fs.writeFile(join(root, 'key'), 'original');
      mocks.storageDeletion.get.mockResolvedValue(original());
      mocks.crypto.compareBcrypt.mockReturnValue(true);
      mocks.storageDeletion.getRecorded.mockResolvedValue([{ backendId: 'originals', key: 'key' }]);

      await expect(sut.purgeOriginal(auth, 'id', { password: 'secret' })).rejects.toThrow('in use again');
      await expect(fs.readdir(root)).resolves.toEqual(['key']);
    });
  });
});
