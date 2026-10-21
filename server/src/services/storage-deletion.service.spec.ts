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
});
