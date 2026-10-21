import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { JobName, JobStatus, StorageBackendDriver, StorageBackendRole } from 'src/enum.js';
import { FAILING_COPY_ATTEMPTS } from 'src/repositories/storage-replica.repository.js';
import { StorageReplicaService } from 'src/services/storage-replica.service.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const copy = (key: string, attempts = 0) => ({
  id: `id-${key}`,
  replicaBackendId: 'copy',
  sourceBackendId: 'originals',
  key,
  attempts,
});

describe(StorageReplicaService.name, () => {
  let sut: StorageReplicaService;
  let mocks: ServiceMocks;
  let root: string;

  const store = async (key: string, content: string) => {
    await mocks.storageBackend.get('originals').put(key, Readable.from([Buffer.from(content)]));
  };

  beforeEach(async () => {
    ({ sut, mocks } = newTestService(StorageReplicaService));
    root = await fs.mkdtemp(join(tmpdir(), 'immich-replica-'));
    mocks.storageBackend.configure([
      {
        id: 'originals',
        driver: StorageBackendDriver.Local,
        role: StorageBackendRole.Originals,
        root: join(root, 'o'),
        encrypted: false,
      },
      {
        id: 'backups',
        driver: StorageBackendDriver.Local,
        role: StorageBackendRole.Backup,
        root: join(root, 'b'),
        encrypted: false,
      },
      {
        id: 'copy',
        driver: StorageBackendDriver.Local,
        role: StorageBackendRole.Replica,
        root: join(root, 'r'),
        encrypted: false,
        replicaOf: [StorageBackendRole.Originals, StorageBackendRole.Backup],
      },
    ]);
    mocks.storageReplica.claim.mockResolvedValueOnce([]);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('should do nothing without replicas', async () => {
    mocks.storageBackend.configure([]);
    await expect(sut.handleReplicate()).resolves.toBe(JobStatus.Skipped);
    await sut.onConfigInit();
    expect(mocks.cron.create).not.toHaveBeenCalled();
  });

  it('should record which backends replicas copy, and register what was stored before for new ones', async () => {
    mocks.storageReplica.setSources.mockResolvedValue([{ replicaBackendId: 'copy', sourceBackendId: 'originals' }]);

    await sut.onBootstrap();

    // database backups are copied when they are stored, not one by one
    expect(mocks.storageReplica.setSources).toHaveBeenCalledWith([
      { replicaBackendId: 'copy', sourceBackendId: 'originals' },
    ]);
    expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.StorageReplicaReconcile, data: { force: true } });
    expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.StorageReplicate });
  });

  it('should copy new originals right away', async () => {
    await sut.onAssetCreate();
    expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.StorageReplicate });
    mocks.job.queue.mockClear();
    await sut.onAssetMetadataExtracted();
    expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.StorageReplicate });

    mocks.storageBackend.configure([]);
    mocks.job.queue.mockClear();
    await sut.onAssetCreate();
    expect(mocks.job.queue).not.toHaveBeenCalled();
  });

  it('should copy a file and record its size', async () => {
    await store('a', 'content');
    mocks.storageReplica.claim
      .mockReset()
      .mockResolvedValueOnce([copy('a')])
      .mockResolvedValue([]);

    await expect(sut.handleReplicate()).resolves.toBe(JobStatus.Success);

    await expect(fs.readFile(join(root, 'r', 'originals', 'a'), 'utf8')).resolves.toBe('content');
    expect(mocks.storageReplica.complete).toHaveBeenCalledWith('id-a', 7, expect.any(Date));
  });

  it('should accept a complete copy made before, whose completion was not recorded', async () => {
    await store('a', 'content');
    await fs.mkdir(join(root, 'r', 'originals'), { recursive: true });
    await fs.writeFile(join(root, 'r', 'originals', 'a'), 'content');
    mocks.storageReplica.claim
      .mockReset()
      .mockResolvedValueOnce([copy('a')])
      .mockResolvedValue([]);

    await sut.handleReplicate();

    expect(mocks.storageReplica.complete).toHaveBeenCalledWith('id-a', 7, expect.any(Date));
  });

  it('should not accept an incomplete copy made before', async () => {
    await store('a', 'content');
    await fs.mkdir(join(root, 'r', 'originals'), { recursive: true });
    await fs.writeFile(join(root, 'r', 'originals', 'a'), 'cont');
    mocks.storageReplica.claim
      .mockReset()
      .mockResolvedValueOnce([copy('a')])
      .mockResolvedValue([]);

    await sut.handleReplicate();

    expect(mocks.storageReplica.complete).not.toHaveBeenCalled();
    expect(mocks.storageReplica.recordFailure).toHaveBeenCalledWith(
      'id-a',
      expect.stringContaining('The replica holds 4 bytes of 7'),
      expect.any(Date),
    );
  });

  it('should delete a copy whose file was deleted while it was made', async () => {
    await store('a', 'content');
    mocks.storageReplica.claim
      .mockReset()
      .mockResolvedValueOnce([copy('a')])
      .mockResolvedValue([]);
    mocks.storageReplica.complete.mockResolvedValue(false);

    await sut.handleReplicate();

    await expect(fs.stat(join(root, 'r', 'originals', 'a'))).rejects.toThrow('ENOENT');
  });

  it('should try a file that was not found again later, and tell the administrator once it keeps failing', async () => {
    mocks.storageReplica.claim
      .mockReset()
      .mockResolvedValueOnce([copy('gone', 0), copy('still-gone', FAILING_COPY_ATTEMPTS - 1)])
      .mockResolvedValue([]);
    mocks.user.getAdmin.mockResolvedValue({ id: 'admin-id' } as never);
    mocks.notification.create.mockResolvedValue({ id: 'notification-id', createdAt: new Date() } as never);

    await sut.handleReplicate();

    expect(mocks.storageReplica.recordFailure).toHaveBeenCalledTimes(2);
    expect(mocks.storageReplica.recordFailure).toHaveBeenCalledWith(
      'id-gone',
      expect.stringContaining('was not found'),
      expect.any(Date),
    );
    expect(mocks.notification.create).toHaveBeenCalledOnce();
    expect(mocks.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Copying files to replicas keeps failing',
        description: expect.stringContaining('1 more files'),
      }),
    );
  });

  it('should tell how far each replica is', async () => {
    mocks.storageReplica.getStatus.mockResolvedValue([
      {
        replicaBackendId: 'copy',
        copied: 2,
        copiedBytes: 20,
        pending: 1,
        failing: 0,
        oldestPendingAt: new Date('2026-10-01'),
      },
    ]);
    mocks.storageReplica.countSourceFiles.mockResolvedValue(3);
    mocks.storageCheck.getLastRun.mockResolvedValue(undefined);

    await expect(sut.getReplicas()).resolves.toEqual({
      replicas: [
        {
          id: 'copy',
          replicaOf: [StorageBackendRole.Originals, StorageBackendRole.Backup],
          sourceFiles: 3,
          copied: 2,
          copiedBytes: 20,
          pending: 1,
          failing: 0,
          oldestPendingAt: '2026-10-01T00:00:00.000Z',
        },
      ],
      lastReconcileAt: null,
    });
    expect(mocks.storageReplica.countSourceFiles).toHaveBeenCalledWith('originals');
    expect(mocks.storageReplica.countSourceFiles).toHaveBeenCalledOnce();
  });
});
