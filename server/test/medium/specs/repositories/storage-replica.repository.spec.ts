import { Kysely } from 'kysely';
import { StorageBackendDriver } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageBackendRepository } from 'src/repositories/storage-backend.repository.js';
import { StorageCheckRepository } from 'src/repositories/storage-check.repository.js';
import {
  FAILING_COPY_ATTEMPTS,
  StorageReplicaRepository,
  toListingId,
} from 'src/repositories/storage-replica.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getTestKyselyDB } from 'test/utils.js';

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const source = { replicaBackendId: 'copy', sourceBackendId: 'originals' };

const setup = async ({ withSource = true } = {}) => {
  const db: Kysely<DB> = await getTestKyselyDB();
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  await ctx.get(StorageBackendRepository).register([
    { id: 'originals', driver: StorageBackendDriver.Local },
    { id: 'copy', driver: StorageBackendDriver.Local },
  ]);
  const sut = ctx.get(StorageReplicaRepository);
  if (withSource) {
    await sut.setSources([source]);
  }
  const { user } = await ctx.newUser();
  const original = async (key: string) => {
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      originalFile: { backendId: 'originals', key, size: 100, checksum: Buffer.alloc(20), encryption: null },
    });
    return asset;
  };
  const copies = () => db.selectFrom('storage_replica_copy').selectAll().orderBy('key').execute();
  return { ctx, db, sut, original, copies };
};

describe(StorageReplicaRepository.name, () => {
  describe('registration', () => {
    it('should register a copy of every new original on a backend that a replica copies', async () => {
      const { ctx, sut, original, copies } = await setup();
      await original('a');
      const { user: other } = await ctx.newUser();
      await ctx.newAsset({ ownerId: other.id });

      await expect(copies()).resolves.toEqual([
        expect.objectContaining({
          replicaBackendId: 'copy',
          sourceBackendId: 'originals',
          key: 'a',
          completedAt: null,
        }),
      ]);
      await expect(sut.getSources()).resolves.toEqual([source]);
    });

    it('should register a copy of an original moved to a backend that a replica copies', async () => {
      const { ctx, copies, original } = await setup();
      const asset = await original('a');
      await ctx
        .get(AssetRepository)
        .updateOriginalPath({ id: asset.id, originalPath: '/b', originalFile: { backendId: 'originals', key: 'b' } });

      await expect(copies().then((rows) => rows.map(({ key }) => key))).resolves.toEqual(['a', 'b']);
    });

    it('should register no copies for a replica that no longer copies the backend', async () => {
      const { sut, original, copies } = await setup();
      await expect(sut.setSources([])).resolves.toEqual([]);
      await original('a');
      await expect(copies()).resolves.toEqual([]);
      await expect(sut.setSources([source])).resolves.toEqual([source]);
      await expect(sut.setSources([source])).resolves.toEqual([]);
    });

    it('should register copies of the originals stored before, a page at a time', async () => {
      const { sut, original, copies } = await setup({ withSource: false });
      for (const key of ['a', 'b', 'c']) {
        await original(key);
      }
      await sut.setSources([source]);

      const first = await sut.registerMissing(source, 2);
      expect(first).toEqual({ registered: 2, lastAssetId: expect.any(String) });
      const second = await sut.registerMissing(source, 2, first.lastAssetId);
      expect(second.registered).toBe(1);
      await expect(sut.registerMissing(source, 2, second.lastAssetId)).resolves.toEqual({ registered: 0 });
      await expect(copies()).resolves.toHaveLength(3);
      // registering again changes nothing
      await expect(sut.registerMissing(source, 10)).resolves.toMatchObject({ registered: 0 });
    });
  });

  describe('copying', () => {
    it('should give each copy to one worker at a time, until its lease ends', async () => {
      const { sut, original } = await setup();
      await original('a');
      await original('b');
      const now = new Date();

      const first = await sut.claim({ now, limit: 1, leaseMs: 60_000 });
      const second = await sut.claim({ now, limit: 10, leaseMs: 60_000 });
      expect([...first, ...second].map(({ key }) => key).toSorted()).toEqual(['a', 'b']);
      await expect(sut.claim({ now, limit: 10, leaseMs: 60_000 })).resolves.toEqual([]);

      const later = new Date(now.getTime() + 61_000);
      await expect(sut.claim({ now: later, limit: 10, leaseMs: 60_000 })).resolves.toHaveLength(2);
    });

    it('should not give out copies to a replica that no longer copies the backend', async () => {
      const { sut, original } = await setup();
      await original('a');
      await sut.setSources([]);
      await expect(sut.claim({ now: new Date(), limit: 10, leaseMs: 60_000 })).resolves.toEqual([]);
    });

    it('should record a copy as made, unless it is no longer registered', async () => {
      const { sut, original, copies } = await setup();
      await original('a');
      const [copy] = await sut.claim({ now: new Date(), limit: 1, leaseMs: 60_000 });

      await expect(sut.complete(copy.id, 300, new Date())).resolves.toBe(true);
      await expect(copies()).resolves.toEqual([
        expect.objectContaining({ size: 300, completedAt: expect.any(Date), leaseUntil: null }),
      ]);
      await expect(sut.claim({ now: new Date(), limit: 1, leaseMs: 60_000 })).resolves.toEqual([]);

      await sut.remove([copy.id]);
      await expect(sut.complete(copy.id, 300, new Date())).resolves.toBe(false);
    });

    it('should try a failed copy again after a pause that doubles every time, and again now when asked', async () => {
      const { sut, original, copies } = await setup();
      await original('a');
      const now = new Date();
      const [copy] = await sut.claim({ now, limit: 1, leaseMs: 60_000 });

      await sut.recordFailure(copy.id, 'Access denied', now);
      let [row] = await copies();
      expect(row).toMatchObject({ attempts: 1, lastError: 'Access denied', leaseUntil: null });
      expect(row.nextAttemptAt.getTime() - now.getTime()).toBe(60_000);
      await expect(sut.claim({ now, limit: 1, leaseMs: 60_000 })).resolves.toEqual([]);

      await sut.recordFailure(copy.id, 'Access denied', now);
      [row] = await copies();
      expect(row.nextAttemptAt.getTime() - now.getTime()).toBe(2 * 60_000);

      await expect(sut.retryFailed('copy', now)).resolves.toBe(1);
      await expect(sut.claim({ now, limit: 1, leaseMs: 60_000 })).resolves.toEqual([
        expect.objectContaining({ key: 'a', attempts: 2 }),
      ]);
    });

    it('should tell how far copying is, and which copies keep failing', async () => {
      const { sut, original, db } = await setup();
      for (const key of ['done', 'waiting', 'failing']) {
        await original(key);
      }
      await db
        .updateTable('storage_replica_copy')
        .set({ completedAt: new Date(), size: 300 })
        .where('key', '=', 'done')
        .execute();
      await db
        .updateTable('storage_replica_copy')
        .set({ attempts: FAILING_COPY_ATTEMPTS, lastError: 'Access denied' })
        .where('key', '=', 'failing')
        .execute();

      await expect(sut.getStatus()).resolves.toEqual([
        {
          replicaBackendId: 'copy',
          copied: 1,
          copiedBytes: 300,
          pending: 2,
          failing: 1,
          oldestPendingAt: expect.any(Date),
        },
      ]);
      await expect(sut.getFailing('copy', 10)).resolves.toEqual([
        expect.objectContaining({ sourceBackendId: 'originals', key: 'failing', lastError: 'Access denied' }),
      ]);
      await expect(sut.countSourceFiles('originals')).resolves.toBe(3);
    });

    it('should find the copies of files, to delete them with the files', async () => {
      const { sut, original } = await setup();
      await original('a');
      await original('b');

      await expect(
        sut.getCopiesOf([
          { backendId: 'originals', key: 'a' },
          { backendId: 'other', key: 'b' },
        ]),
      ).resolves.toEqual([
        expect.objectContaining({ replicaBackendId: 'copy', sourceBackendId: 'originals', key: 'a' }),
      ]);
      await expect(sut.getCopiesOf([])).resolves.toEqual([]);
    });
  });

  describe('reconciliation', () => {
    it('should compare the listing of a replica with the copies made, and copy again what is missing', async () => {
      const { ctx, sut, original, db, copies } = await setup();
      for (const key of ['listed', 'missing', 'resized', 'new', 'waiting']) {
        await original(key);
      }
      await db
        .updateTable('storage_replica_copy')
        .set({ completedAt: ago(10), size: 300 })
        .where('key', 'in', ['listed', 'missing', 'resized'])
        .execute();
      await db
        .updateTable('storage_replica_copy')
        .set({ completedAt: new Date(), size: 300 })
        .where('key', '=', 'new')
        .execute();
      const checks = ctx.get(StorageCheckRepository);
      await checks.addToListing(toListingId(source), [
        { key: 'listed', size: 300, lastModified: ago(10) },
        { key: 'resized', size: 299, lastModified: ago(10) },
        { key: 'waiting', size: 10, lastModified: ago(10) },
        { key: 'orphan', size: 5, lastModified: ago(10) },
        { key: 'just-written', size: 5, lastModified: new Date() },
      ]);

      const before = ago(2);
      await expect(sut.findMissing(source, before)).resolves.toEqual([{ key: 'missing' }]);
      await expect(sut.findSizeMismatches(source)).resolves.toEqual([
        { key: 'resized', detail: 'copied 300 bytes, stored 299 bytes' },
      ]);
      await expect(sut.findUntracked(source, before)).resolves.toEqual([{ key: 'orphan', detail: '5 bytes' }]);

      await sut.requeue(source, ['missing', 'resized'], new Date());
      const rows = await copies();
      expect(rows.filter(({ completedAt }) => completedAt === null).map(({ key }) => key)).toEqual([
        'missing',
        'resized',
        'waiting',
      ]);
    });
  });
});
