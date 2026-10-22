import { Kysely } from 'kysely';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { StorageCore } from 'src/cores/storage.core.js';
import { JobStatus, StorageBackendDriver, StorageBackendRole, StorageIssueKind } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { MasterKeys } from 'src/repositories/key-provider.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { NotificationRepository } from 'src/repositories/notification.repository.js';
import { StorageBackendRepository, readBlob } from 'src/repositories/storage-backend.repository.js';
import { StorageCheckRepository } from 'src/repositories/storage-check.repository.js';
import { StorageDeletionRepository } from 'src/repositories/storage-deletion.repository.js';
import { StorageReplicaRepository } from 'src/repositories/storage-replica.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { StorageCheckService } from 'src/services/storage-check.service.js';
import { StorageDeletionService } from 'src/services/storage-deletion.service.js';
import { StorageReplicaService } from 'src/services/storage-replica.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { getTestKyselyDB } from 'test/utils.js';

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

/** Delete an asset, and register its original for deletion as if it was deleted long enough ago */
const deleteLongAgo = async (db: Kysely<DB>, assetId: string, key: string) => {
  await db.deleteFrom('asset').where('id', '=', assetId).execute();
  await new StorageDeletionRepository(db).register([
    { backendId: 'originals', key, notBefore: ago(1), isOriginal: true, createdAt: ago(400) },
  ]);
};

describe(StorageReplicaService.name, () => {
  let root: string;

  const setup = async () => {
    const db: Kysely<DB> = await getTestKyselyDB();
    const { sut, ctx } = newMediumService(StorageReplicaService, {
      database: db,
      real: [
        AssetRepository,
        NotificationRepository,
        StorageBackendRepository,
        StorageCheckRepository,
        StorageDeletionRepository,
        StorageReplicaRepository,
        SystemMetadataRepository,
        UserRepository,
      ],
      mock: [ConfigRepository, JobRepository, LoggingRepository, WebsocketRepository],
    });
    ctx.getMock(ConfigRepository).getEnv.mockReturnValue(mockEnvData({}));
    ctx.getMock(WebsocketRepository).clientSend.mockReturnValue();
    ctx.getMock(JobRepository).queue.mockResolvedValue();
    const keys = new MasterKeys([randomBytes(32)]);
    const backends = ctx.get(StorageBackendRepository);
    await backends.register([
      { id: 'originals', driver: StorageBackendDriver.Local },
      { id: 'copy', driver: StorageBackendDriver.Local },
    ]);
    backends.configure(
      [
        {
          id: 'originals',
          driver: StorageBackendDriver.Local,
          role: StorageBackendRole.Originals,
          root: join(root, 'originals'),
          encrypted: true,
        },
        {
          id: 'copy',
          driver: StorageBackendDriver.Local,
          role: StorageBackendRole.Replica,
          root: join(root, 'replica'),
          encrypted: true,
          replicaOf: [StorageBackendRole.Originals],
        },
      ],
      keys,
    );
    await sut.onBootstrap();
    const { user } = await ctx.newUser({ isAdmin: true });

    const original = async (content: Buffer) => {
      const upload = join(root, `${randomBytes(4).toString('hex')}.upload`);
      await fs.writeFile(upload, content);
      const stored = await backends.storeFile(StorageBackendRole.Originals, upload);
      await fs.rm(upload);
      const { asset } = await ctx.newAsset({ ownerId: user.id, originalFile: stored });
      return { asset, stored };
    };
    const copyPath = (key: string) => join(root, 'replica', 'originals', key);
    const deletion = BaseService.create(StorageDeletionService, sut as BaseService);
    const checks = BaseService.create(StorageCheckService, sut as BaseService);
    return { sut, ctx, db, keys, backends, original, copyPath, deletion, checks };
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'immich-storage-replica-'));
    StorageCore.setMediaLocation(join(root, 'media'));
  });

  afterEach(async () => {
    StorageCore.setMediaLocation('/data');
    await fs.rm(root, { recursive: true, force: true });
  });

  it('should copy originals as they are stored, to a folder that can take the place of their backend', async () => {
    const { sut, keys, original, copyPath } = await setup();
    const content = randomBytes(200_000);
    const { stored } = await original(content);

    await expect(sut.handleReplicate()).resolves.toBe(JobStatus.Success);

    const copy = await fs.readFile(copyPath(stored.key));
    await expect(fs.readFile(join(root, 'originals', stored.key))).resolves.toEqual(copy);
    expect(copy.includes(content.subarray(0, 64))).toBe(false);
    await expect(sut.getReplicas()).resolves.toEqual({
      replicas: [
        expect.objectContaining({ id: 'copy', replicaOf: ['originals'], sourceFiles: 1, copied: 1, pending: 0 }),
      ],
      lastReconcileAt: null,
    });

    // the backend lost, the replica takes its place: the same records read the same file there
    const promoted = new StorageBackendRepository(undefined as never, LoggingRepository.create());
    promoted.configure(
      [
        {
          id: 'originals',
          driver: StorageBackendDriver.Local,
          role: StorageBackendRole.Originals,
          root: join(root, 'replica', 'originals'),
          encrypted: true,
        },
      ],
      keys,
    );
    const source = promoted.resolve({ path: '/photo.jpg', ...stored });
    expect('blob' in source).toBe(true);
    if ('blob' in source) {
      await expect(readBlob(source.blob).then((stream) => buffer(stream))).resolves.toEqual(content);
    }
  });

  it('should retry a copy that failed, and tell why', async () => {
    const { sut, db, original, copyPath } = await setup();
    const { stored } = await original(randomBytes(100));
    // a file where the folder of the backend should be
    await fs.mkdir(join(root, 'replica'), { recursive: true });
    await fs.writeFile(join(root, 'replica', 'originals'), 'in the way');

    await sut.handleReplicate();
    const [failed] = await db.selectFrom('storage_replica_copy').selectAll().execute();
    expect(failed).toMatchObject({ attempts: 1, completedAt: null, lastError: expect.any(String) });

    await fs.rm(join(root, 'replica', 'originals'));
    await expect(sut.retryFailed('copy')).resolves.toEqual({ count: 1 });
    await sut.handleReplicate();
    await expect(fs.stat(copyPath(stored.key))).resolves.toBeDefined();
    await expect(sut.retryFailed('originals')).rejects.toThrow('not a replica');
  });

  it('should delete the copies of a deleted original before the original, once its delay has passed', async () => {
    const { sut, db, original, copyPath, deletion } = await setup();
    const { asset, stored } = await original(randomBytes(100));
    await sut.handleReplicate();
    await deleteLongAgo(db, asset.id, stored.key);

    await expect(deletion.handleStorageDeletionRun()).resolves.toBe(JobStatus.Success);

    await expect(fs.stat(copyPath(stored.key))).rejects.toThrow('ENOENT');
    await expect(fs.stat(join(root, 'originals', stored.key))).rejects.toThrow('ENOENT');
    await expect(db.selectFrom('storage_replica_copy').selectAll().execute()).resolves.toEqual([]);
    await expect(db.selectFrom('storage_deletion').selectAll().execute()).resolves.toEqual([]);
  });

  it('should keep a deleted original while a replica refuses to delete its copy', async () => {
    const { sut, db, backends, original, copyPath, deletion } = await setup();
    const { asset, stored } = await original(randomBytes(100));
    await sut.handleReplicate();
    await deleteLongAgo(db, asset.id, stored.key);
    // e.g. while the copy is locked
    vi.spyOn(backends.getReplicaStore('copy', 'originals', { deletion: true }), 'deleteMany').mockResolvedValue({
      failed: [stored.key],
    });

    await deletion.handleStorageDeletionRun();

    await expect(fs.stat(copyPath(stored.key))).resolves.toBeDefined();
    await expect(fs.stat(join(root, 'originals', stored.key))).resolves.toBeDefined();
    const [registration] = await db.selectFrom('storage_deletion').selectAll().execute();
    expect(registration).toMatchObject({ attempts: 1, lastError: 'A replica did not delete its copy of the file' });
  });

  it('should register copies of what was stored before, and copy again what a replica lost', async () => {
    const { sut, ctx, db, original, copyPath, checks } = await setup();
    // stored before the replica was configured
    await ctx.get(StorageReplicaRepository).setSources([]);
    const { stored: before } = await original(randomBytes(100));
    await sut.onBootstrap();
    const { stored: lost } = await original(randomBytes(100));
    await sut.handleReplicate();
    await expect(db.selectFrom('storage_replica_copy').selectAll().execute()).resolves.toHaveLength(1);

    await expect(checks.handleReplicaReconcile({ force: true })).resolves.toBe(JobStatus.Success);
    await sut.handleReplicate();
    await expect(fs.stat(copyPath(before.key))).resolves.toBeDefined();

    await db
      .updateTable('storage_replica_copy')
      .set({ completedAt: ago(10) })
      .execute();
    await fs.rm(copyPath(lost.key));
    await fs.writeFile(copyPath('orphan'), 'nothing records me');
    await fs.utimes(copyPath('orphan'), ago(10), ago(10));
    await checks.handleReplicaReconcile({ force: true });
    await sut.handleReplicate();

    await expect(fs.stat(copyPath(lost.key))).resolves.toBeDefined();
    // reported once seen twice, never deleted
    await checks.handleReplicaReconcile({ force: true });
    const { items } = await checks.getIssues({ status: 'open' });
    expect(items).toEqual([
      expect.objectContaining({ backendId: 'copy', key: 'originals/orphan', kind: StorageIssueKind.Untracked }),
    ]);
    await expect(fs.readFile(copyPath('orphan'), 'utf8')).resolves.toBe('nothing records me');
  });

  it('should only reconcile replicas every two weeks', async () => {
    const { checks, original } = await setup();
    await original(randomBytes(10));
    await expect(checks.handleReplicaReconcile()).resolves.toBe(JobStatus.Success);
    await expect(checks.handleReplicaReconcile()).resolves.toBe(JobStatus.Skipped);
  });
});
