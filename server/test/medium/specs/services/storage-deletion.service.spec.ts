import { Kysely } from 'kysely';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { JobStatus, StorageBackendDriver, StorageBackendRole } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { NotificationRepository } from 'src/repositories/notification.repository.js';
import { StorageBackendRepository } from 'src/repositories/storage-backend.repository.js';
import { StorageDeletionRepository } from 'src/repositories/storage-deletion.repository.js';
import { StorageReplicaRepository } from 'src/repositories/storage-replica.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DB } from 'src/schema/index.js';
import { StorageDeletionService } from 'src/services/storage-deletion.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { getTestKyselyDB } from 'test/utils.js';

describe(StorageDeletionService.name, () => {
  let root: string;

  const setup = async () => {
    const db: Kysely<DB> = await getTestKyselyDB();
    const { sut, ctx } = newMediumService(StorageDeletionService, {
      database: db,
      real: [
        NotificationRepository,
        StorageBackendRepository,
        StorageDeletionRepository,
        StorageReplicaRepository,
        SystemMetadataRepository,
        UserRepository,
      ],
      mock: [ConfigRepository, JobRepository, LoggingRepository, WebsocketRepository],
    });
    ctx.getMock(ConfigRepository).getEnv.mockReturnValue(mockEnvData({}));
    const backends = ctx.get(StorageBackendRepository);
    await backends.register([{ id: 'originals', driver: StorageBackendDriver.Local }]);
    backends.configure([
      {
        id: 'originals',
        driver: StorageBackendDriver.Local,
        role: StorageBackendRole.Originals,
        root: join(root, 'bucket'),
        encrypted: false,
      },
    ]);
    const store = async () => {
      const upload = join(root, 'upload.jpg');
      await fs.writeFile(upload, 'photo');
      return backends.storeFile(StorageBackendRole.Originals, upload);
    };
    const makeDue = () =>
      db
        .updateTable('storage_deletion')
        .set({ notBefore: new Date(Date.now() - 1000) })
        .execute();
    return { sut, ctx, db, store, makeDue };
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'immich-storage-deletion-'));
    StorageCore.setMediaLocation(join(root, 'media'));
  });

  afterEach(async () => {
    StorageCore.setMediaLocation('/data');
    await fs.rm(root, { recursive: true, force: true });
  });

  it('should delete a file that was written but never recorded, once its day has passed', async () => {
    const { sut, db, store, makeDue } = await setup();
    const { key } = await store();

    // not before a day has passed: recording it may still be under way
    await sut.handleStorageDeletionRun();
    await expect(fs.stat(join(root, 'bucket', key))).resolves.toBeDefined();

    await makeDue();
    await expect(sut.handleStorageDeletionRun()).resolves.toBe(JobStatus.Success);

    await expect(fs.stat(join(root, 'bucket', key))).rejects.toThrow('ENOENT');
    await expect(db.selectFrom('storage_deletion').selectAll().execute()).resolves.toEqual([]);
  });

  it('should keep a file that was written and recorded, and drop its registration', async () => {
    const { sut, ctx, db, store, makeDue } = await setup();
    const stored = await store();
    const { user } = await ctx.newUser();
    await ctx.newAsset({ ownerId: user.id, originalFile: stored });

    await makeDue();
    await sut.handleStorageDeletionRun();

    await expect(fs.readFile(join(root, 'bucket', stored.key), 'utf8')).resolves.toBe('photo');
    await expect(db.selectFrom('storage_deletion').selectAll().execute()).resolves.toEqual([]);
  });
});
