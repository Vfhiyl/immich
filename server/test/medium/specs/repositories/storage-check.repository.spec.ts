import { Kysely } from 'kysely';
import { AssetFileType, StorageBackendDriver, StorageIssueKind } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageBackendRepository } from 'src/repositories/storage-backend.repository.js';
import { StorageCheckRepository } from 'src/repositories/storage-check.repository.js';
import { StorageDeletionRepository } from 'src/repositories/storage-deletion.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getTestKyselyDB } from 'test/utils.js';

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

const setup = async () => {
  const db: Kysely<DB> = await getTestKyselyDB();
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  await ctx.get(StorageBackendRepository).register([{ id: 'originals', driver: StorageBackendDriver.Local }]);
  const { user } = await ctx.newUser();
  /** An original recorded on the backend, `days` ago */
  const original = async (key: string, { days = 10, size = 100, encrypted = false } = {}) => {
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      originalFile: {
        backendId: 'originals',
        key,
        size,
        checksum: Buffer.alloc(20, 1),
        encryption: encrypted ? Buffer.alloc(66) : null,
      },
    });
    await db
      .updateTable('asset_original_file')
      .set({ createdAt: ago(days) })
      .where('assetId', '=', asset.id)
      .execute();
    return asset;
  };
  return { ctx, db, user, original, sut: ctx.get(StorageCheckRepository) };
};

const keys = (issues: Array<{ key: string }>) => issues.map(({ key }) => key).toSorted((a, b) => a.localeCompare(b));

describe(StorageCheckRepository.name, () => {
  describe('reconciliation', () => {
    it('should find recorded files that are not listed, once they are old enough', async () => {
      const { sut, original } = await setup();
      await original('listed');
      await original('gone');
      await original('new', { days: 1 });
      await sut.addToListing('originals', [{ key: 'listed', size: 100, lastModified: ago(10) }]);

      await expect(sut.findMissing('originals', ago(2)).then(keys)).resolves.toEqual(['gone']);
    });

    it('should find listed files that nothing records, once they are old enough', async () => {
      const { sut, ctx, original } = await setup();
      await original('recorded');
      await ctx
        .get(StorageDeletionRepository)
        .register([{ backendId: 'originals', key: 'pending-deletion', notBefore: new Date(), isOriginal: true }]);
      await sut.addToListing('originals', [
        { key: 'recorded', size: 100, lastModified: ago(10) },
        { key: 'pending-deletion', size: 1, lastModified: ago(10) },
        { key: 'orphan', size: 5, lastModified: ago(10) },
        { key: 'just-written', size: 5, lastModified: ago(1) },
        { key: '.immich-probe/abc', size: 5, lastModified: ago(10) },
      ]);

      const untracked = await sut.findUntracked('originals', ago(2));
      expect(untracked).toEqual([{ key: 'orphan', detail: '5 bytes' }]);
    });

    it('should find files of another size than recorded, allowing for encryption', async () => {
      const { sut, original } = await setup();
      await original('same', { size: 100 });
      await original('shorter', { size: 100 });
      // 100 bytes encrypted: one chunk of 100 + 16 bytes, and a trailer of a little over a hundred bytes
      await original('encrypted', { size: 100, encrypted: true });
      await original('encrypted-short', { size: 100, encrypted: true });
      await sut.addToListing('originals', [
        { key: 'same', size: 100, lastModified: ago(10) },
        { key: 'shorter', size: 50, lastModified: ago(10) },
        { key: 'encrypted', size: 100 + 16 + 200, lastModified: ago(10) },
        { key: 'encrypted-short', size: 100, lastModified: ago(10) },
      ]);

      const mismatches = await sut.findSizeMismatches('originals');
      expect(keys(mismatches)).toEqual(['encrypted-short', 'shorter']);
      expect(mismatches.find(({ key }) => key === 'shorter')?.detail).toBe('recorded 100 bytes, stored 50 bytes');
    });

    it('should keep the listings of backends apart, and clear them', async () => {
      const { sut, original } = await setup();
      await original('a');
      await sut.addToListing('originals', [{ key: 'a', size: 100, lastModified: ago(10) }]);
      await sut.clearListing('originals');

      await expect(sut.findMissing('originals', ago(2)).then(keys)).resolves.toEqual(['a']);
    });
  });

  describe('issues', () => {
    it('should report an issue the second time it is seen, and resolve it when it is no longer seen', async () => {
      const { sut, db } = await setup();
      const first = new Date();
      await expect(sut.recordSightings('originals', StorageIssueKind.Missing, [{ key: 'a' }], first)).resolves.toBe(0);
      await expect(sut.countOpenIssues()).resolves.toBe(0);

      const second = new Date(first.getTime() + 1000);
      await expect(sut.recordSightings('originals', StorageIssueKind.Missing, [{ key: 'a' }], second)).resolves.toBe(1);
      await expect(sut.countOpenIssues()).resolves.toBe(1);
      // a third sighting does not report it again
      const third = new Date(first.getTime() + 2000);
      await expect(sut.recordSightings('originals', StorageIssueKind.Missing, [{ key: 'a' }], third)).resolves.toBe(0);

      await sut.resolveUnseen('originals', [StorageIssueKind.Missing], new Date(first.getTime() + 3000));
      await expect(sut.countOpenIssues()).resolves.toBe(0);
      const [issue] = await db.selectFrom('storage_issue').selectAll().execute();
      expect(issue).toMatchObject({ sightings: 3, confirmedAt: second, resolvedAt: expect.any(Date) });

      // seen again later, it is a new issue
      await sut.recordSightings('originals', StorageIssueKind.Missing, [{ key: 'a' }], new Date());
      await expect(db.selectFrom('storage_issue').selectAll().execute()).resolves.toHaveLength(2);
    });

    it('should resolve the issues of a file that verified fine', async () => {
      const { sut } = await setup();
      for (const at of [new Date(), new Date(Date.now() + 1000)]) {
        await sut.recordSightings('originals', StorageIssueKind.Corrupt, [{ key: 'a' }], at);
      }
      await expect(sut.countOpenIssues()).resolves.toBe(1);

      await sut.resolveIssues('originals', 'a', [StorageIssueKind.Corrupt, StorageIssueKind.Unreadable]);
      await expect(sut.countOpenIssues()).resolves.toBe(0);
    });
  });

  describe('verification', () => {
    it('should pick files that failed, then ones never verified, then the oldest verified', async () => {
      const { sut, ctx, user, original } = await setup();
      await original('never');
      await original('failed');
      await original('old');
      await original('recent');
      await original('new', { days: 0 });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: '/p.jpg',
        backendId: 'originals',
        key: 'never-preview',
      });
      const runStart = new Date();
      await sut.recordVerification('originals', 'failed', false, ago(1));
      await sut.recordVerification('originals', 'old', true, ago(80));
      await sut.recordVerification('originals', 'recent', true, ago(5));

      await expect(sut.countVerifiable(['originals'], ago(1))).resolves.toBe(4);
      await expect(sut.getFailedVerifications(['originals'], runStart, 10)).resolves.toEqual([
        { backendId: 'originals', key: 'failed' },
      ]);
      // the preview was recorded just now
      await expect(sut.getUnverified(['originals'], ago(1), 10).then(keys)).resolves.toEqual(['never']);
      await expect(sut.getOldestVerified(['originals'], runStart, 10)).resolves.toEqual([
        { backendId: 'originals', key: 'old' },
        { backendId: 'originals', key: 'recent' },
      ]);

      // verified during this run, a file is not picked again in it
      await sut.recordVerification('originals', 'old', true, new Date());
      await expect(sut.getOldestVerified(['originals'], runStart, 10).then(keys)).resolves.toEqual(['recent']);
    });

    it('should tell what is recorded about files, and forget the verification of others', async () => {
      const { sut, db, original } = await setup();
      await original('kept', { size: 42 });
      await sut.recordVerification('originals', 'kept', true, ago(1));
      await sut.recordVerification('originals', 'deleted', true, ago(1));

      await expect(sut.getRecordedFiles('originals', ['kept', 'deleted'])).resolves.toEqual([
        { backendId: 'originals', key: 'kept', size: 42, checksum: Buffer.alloc(20, 1), encryption: null },
      ]);
      await sut.removeVerifications('originals', ['deleted']);
      const rows = await db.selectFrom('storage_verification').select('key').execute();
      expect(rows).toEqual([{ key: 'kept' }]);
    });
  });
});
