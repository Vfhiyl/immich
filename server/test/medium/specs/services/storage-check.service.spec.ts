import { Kysely } from 'kysely';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import {
  JobStatus,
  StorageBackendDriver,
  StorageBackendRole,
  StorageCheckKind,
  StorageCheckStatus,
  StorageIssueKind,
} from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { MasterKeys } from 'src/repositories/key-provider.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { NotificationRepository } from 'src/repositories/notification.repository.js';
import { StorageBackendRepository } from 'src/repositories/storage-backend.repository.js';
import { StorageCheckRepository } from 'src/repositories/storage-check.repository.js';
import { StorageDeletionRepository } from 'src/repositories/storage-deletion.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DB } from 'src/schema/index.js';
import { StorageCheckService } from 'src/services/storage-check.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { getKyselyDB } from 'test/utils.js';

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

describe(StorageCheckService.name, () => {
  let root: string;

  const setup = async ({ encrypted = false } = {}) => {
    const db: Kysely<DB> = await getKyselyDB();
    const { sut, ctx } = newMediumService(StorageCheckService, {
      database: db,
      real: [
        AssetRepository,
        NotificationRepository,
        StorageBackendRepository,
        StorageCheckRepository,
        StorageDeletionRepository,
        SystemMetadataRepository,
        UserRepository,
      ],
      mock: [ConfigRepository, JobRepository, LoggingRepository, WebsocketRepository],
    });
    ctx.getMock(ConfigRepository).getEnv.mockReturnValue(mockEnvData({}));
    ctx.getMock(WebsocketRepository).clientSend.mockReturnValue();
    const backends = ctx.get(StorageBackendRepository);
    await backends.register([{ id: 'originals', driver: StorageBackendDriver.Local }]);
    backends.configure(
      [{ id: 'originals', driver: StorageBackendDriver.Local, role: StorageBackendRole.Originals, root, encrypted }],
      encrypted ? new MasterKeys([randomBytes(32)]) : undefined,
    );
    const { user } = await ctx.newUser({ isAdmin: true });

    /** An original stored on the backend ten days ago, as files on a backend are written */
    const original = async (content: Buffer) => {
      const upload = join(root, `${randomBytes(4).toString('hex')}.upload`);
      await fs.writeFile(upload, content);
      const stored = await backends.storeFile(StorageBackendRole.Originals, upload);
      await fs.rm(upload);
      const { asset } = await ctx.newAsset({ ownerId: user.id, originalFile: stored });
      await db
        .updateTable('asset_original_file')
        .set({ createdAt: ago(10) })
        .where('assetId', '=', asset.id)
        .execute();
      await fs.utimes(join(root, stored.key), ago(10), ago(10));
      return stored.key;
    };
    const issues = async () => {
      const { items } = await sut.getIssues({ status: 'open' });
      return items.map(({ key, kind }) => ({ key, kind }));
    };
    return { sut, ctx, db, original, issues };
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'immich-storage-check-'));
    StorageCore.setMediaLocation(join(root, 'media'));
  });

  afterEach(async () => {
    StorageCore.setMediaLocation('/data');
    await fs.rm(root, { recursive: true, force: true });
  });

  describe('reconciliation', () => {
    it('should report missing, untracked and resized files after two runs, and resolve them once fixed', async () => {
      const { sut, original, issues, db } = await setup();
      await original(randomBytes(100));
      const missing = await original(randomBytes(100));
      const resized = await original(randomBytes(100));
      const missingContent = await fs.readFile(join(root, missing));
      await fs.rm(join(root, missing));
      await fs.writeFile(join(root, resized), randomBytes(50));
      await fs.utimes(join(root, resized), ago(10), ago(10));
      await fs.writeFile(join(root, 'orphan'), 'nothing records me');
      await fs.utimes(join(root, 'orphan'), ago(10), ago(10));

      await expect(sut.handleReconcile({ force: true })).resolves.toBe(JobStatus.Success);
      // a first sighting is not reported yet
      await expect(issues()).resolves.toEqual([]);

      await sut.handleReconcile({ force: true });
      const reported = await issues();
      expect(reported).toHaveLength(3);
      expect(reported).toEqual(
        expect.arrayContaining([
          { key: missing, kind: StorageIssueKind.Missing },
          { key: resized, kind: StorageIssueKind.SizeMismatch },
          { key: 'orphan', kind: StorageIssueKind.Untracked },
        ]),
      );
      const [run] = await sut.getRuns({});
      expect(run).toMatchObject({ kind: 'reconcile', status: StorageCheckStatus.Issues, checked: 3, newIssues: 3 });
      // nothing was changed or deleted
      await expect(fs.readFile(join(root, 'orphan'), 'utf8')).resolves.toBe('nothing records me');
      const notifications = await db.selectFrom('notification').select('title').execute();
      expect(notifications).toEqual([{ title: 'Storage check found problems' }]);

      await fs.writeFile(join(root, missing), missingContent);
      await sut.handleReconcile({ force: true });
      const remaining = await issues();
      expect(remaining.map(({ key }) => key)).not.toContain(missing);
      await expect(sut.getSummary()).resolves.toMatchObject({
        openIssues: { [StorageIssueKind.SizeMismatch]: 1, [StorageIssueKind.Untracked]: 1 },
        lastReconcile: expect.objectContaining({ openIssues: 2 }),
      });
    });

    it('should not run again so soon after a scheduled run', async () => {
      const { sut, original } = await setup();
      await original(randomBytes(10));

      await expect(sut.handleReconcile()).resolves.toBe(JobStatus.Success);
      await expect(sut.handleReconcile()).resolves.toBe(JobStatus.Skipped);
    });
  });

  describe('verification', () => {
    it('should read files back, and report one whose content changed after two runs', async () => {
      const { sut, original, issues } = await setup();
      await original(randomBytes(1000));
      const changed = await original(randomBytes(1000));
      await fs.writeFile(join(root, changed), randomBytes(1000));

      await expect(sut.handleVerify()).resolves.toBe(JobStatus.Success);
      await expect(issues()).resolves.toEqual([]);
      const [first] = await sut.getRuns({ kind: StorageCheckKind.Verify });
      expect(first).toMatchObject({ checked: 2, bytes: 2000 });

      // the file that failed is read again first
      await sut.handleVerify();
      await expect(issues()).resolves.toEqual([{ key: changed, kind: StorageIssueKind.Corrupt }]);
    });

    it('should report an encrypted file that no longer decrypts', async () => {
      const { sut, original, issues } = await setup({ encrypted: true });
      const key = await original(randomBytes(5000));
      const stored = await fs.readFile(join(root, key));
      stored[100] ^= 1;
      await fs.writeFile(join(root, key), stored);

      await sut.handleVerify();
      await sut.handleVerify();

      await expect(issues()).resolves.toEqual([{ key, kind: StorageIssueKind.Corrupt }]);
    });

    it('should export and acknowledge reported issues', async () => {
      const { sut, original } = await setup();
      const changed = await original(randomBytes(10));
      await fs.writeFile(join(root, changed), 'other');
      await sut.handleVerify();
      await sut.handleVerify();

      const lines = await Array.fromAsync(sut.getIssuesCsv());
      const csv = lines.join('');
      expect(lines[0]).toBe(
        'id,backendId,key,kind,detail,firstSeenAt,lastSeenAt,confirmedAt,resolvedAt,acknowledgedAt\n',
      );
      expect(csv).toContain(`"${changed}","corrupt"`);

      const {
        items: [issue],
      } = await sut.getIssues({});
      await sut.acknowledgeIssue(issue.id);
      const { items } = await sut.getIssues({});
      expect(items[0].acknowledgedAt).toEqual(expect.any(String));
      await expect(sut.acknowledgeIssue('00000000-0000-4000-8000-000000000000')).rejects.toThrow('not found');
    });

    it('should leave new files for a day, since they were verified when they were written', async () => {
      const { sut, db, original } = await setup();
      await original(randomBytes(10));
      await db.updateTable('asset_original_file').set({ createdAt: new Date() }).execute();

      await sut.handleVerify();

      const [run] = await sut.getRuns({});
      expect(run).toMatchObject({ checked: 0, status: StorageCheckStatus.Ok });
    });
  });
});
