import { Kysely } from 'kysely';
import { AssetFileType, StorageBackendDriver } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { StorageBackendRepository } from 'src/repositories/storage-backend.repository.js';
import { StorageDeletionRepository } from 'src/repositories/storage-deletion.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

const DAY = 24 * 60 * 60 * 1000;

const setup = async () => {
  const db: Kysely<DB> = await getKyselyDB();
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  await ctx.get(StorageBackendRepository).register([
    { id: 'originals', driver: StorageBackendDriver.Local },
    { id: 'derived', driver: StorageBackendDriver.Local },
  ]);
  return { ctx, db, sut: ctx.get(StorageDeletionRepository) };
};

const daysFromNow = (days: number) => new Date(Date.now() + days * DAY);

describe(StorageDeletionRepository.name, () => {
  describe('register', () => {
    it('should keep the first registration of a file', async () => {
      const { sut, db } = await setup();

      await sut.register([{ backendId: 'derived', key: 'a', notBefore: daysFromNow(30), isOriginal: false }]);
      await sut.register([{ backendId: 'derived', key: 'a', notBefore: daysFromNow(1), isOriginal: false }]);
      await sut.register([]);

      const rows = await db.selectFrom('storage_deletion').select(['key', 'notBefore']).execute();
      expect(rows).toHaveLength(1);
      expect(rows[0].notBefore.getTime()).toBeGreaterThan(daysFromNow(29).getTime());
    });
  });

  describe('writes', () => {
    it('should register a file before it is written, and replace that by a deletion', async () => {
      const { ctx, sut, db } = await setup();
      const backends = ctx.get(StorageBackendRepository);
      await backends.registerWrite('originals', 'a');
      await backends.registerWrite('originals', 'a');

      let rows = await db.selectFrom('storage_deletion').selectAll().execute();
      expect(rows).toEqual([expect.objectContaining({ key: 'a', isWrite: true, isOriginal: false })]);
      expect(rows[0].notBefore.getTime()).toBeGreaterThan(daysFromNow(0.9).getTime());
      // not a deletion anyone asked for
      await expect(sut.countPending()).resolves.toEqual({ originals: 0, files: 0 });

      await sut.register([
        {
          backendId: 'originals',
          key: 'a',
          notBefore: daysFromNow(360),
          isOriginal: true,
          originalFileName: 'IMG_0001.jpg',
        },
      ]);
      rows = await db.selectFrom('storage_deletion').selectAll().execute();
      expect(rows).toEqual([
        expect.objectContaining({ isWrite: false, isOriginal: true, originalFileName: 'IMG_0001.jpg' }),
      ]);
      expect(rows[0].notBefore.getTime()).toBeGreaterThan(daysFromNow(359).getTime());

      // a deletion is not replaced by a write
      await backends.registerWrite('originals', 'a');
      await expect(sut.countPending()).resolves.toEqual({ originals: 1, files: 1 });
    });
  });

  describe('getDue', () => {
    it('should return files whose time has come, the longest waiting first', async () => {
      const { sut } = await setup();
      await sut.register([
        { backendId: 'derived', key: 'later', notBefore: daysFromNow(1), isOriginal: false },
        { backendId: 'derived', key: 'second', notBefore: daysFromNow(-1), isOriginal: false },
        { backendId: 'derived', key: 'first', notBefore: daysFromNow(-2), isOriginal: false },
      ]);

      const due = await sut.getDue({ now: new Date(), originalsDelayDays: 360, limit: 10 });

      expect(due.map(({ key }) => key)).toEqual(['first', 'second']);
      await expect(sut.getDue({ now: new Date(), originalsDelayDays: 360, limit: 1 })).resolves.toHaveLength(1);
    });

    it('should apply a longer configured delay to originals registered with a shorter one', async () => {
      const { sut } = await setup();
      // registered 100 days ago with a delay of 90 days
      await sut.register([
        {
          backendId: 'originals',
          key: 'original',
          notBefore: daysFromNow(-10),
          isOriginal: true,
          createdAt: daysFromNow(-100),
        },
        {
          backendId: 'derived',
          key: 'derived',
          notBefore: daysFromNow(-10),
          isOriginal: false,
          createdAt: daysFromNow(-100),
        },
      ]);

      const longer = await sut.getDue({ now: new Date(), originalsDelayDays: 360, limit: 10 });
      expect(longer.map(({ key }) => key)).toEqual(['derived']);
      await expect(sut.countDueOriginals({ now: new Date(), originalsDelayDays: 360 })).resolves.toBe(0);

      // a shorter delay never deletes before the registered time either
      const shorter = await sut.getDue({ now: new Date(), originalsDelayDays: 30, limit: 10 });
      expect(shorter.map(({ key }) => key).toSorted()).toEqual(['derived', 'original']);
      await expect(sut.countDueOriginals({ now: new Date(), originalsDelayDays: 30 })).resolves.toBe(1);
      await expect(sut.countDueOriginals({ now: daysFromNow(-20), originalsDelayDays: 30 })).resolves.toBe(0);
    });
  });

  describe('getRecorded', () => {
    it('should find the files that are still recorded, in any of the file tables', async () => {
      const { sut, ctx } = await setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, originalFile: { backendId: 'originals', key: 'o' } });
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: '/data/p.jpg',
        backendId: 'derived',
        key: 'p',
      });
      const { person } = await ctx.newPerson({ ownerId: user.id });
      await ctx.get(PersonRepository).updateThumbnail({
        ownerId: user.id,
        personGroupId: person.personGroupId,
        thumbnailPath: '/data/t.jpg',
        thumbnailFile: { backendId: 'derived', key: 't' },
      });
      await ctx.get(UserRepository).updateProfileImage(user.id, {
        profileImagePath: '/data/u.jpg',
        profileImageFile: { backendId: 'derived', key: 'u' },
        profileChangedAt: new Date(),
      });

      const recorded = await sut.getRecorded([
        { backendId: 'originals', key: 'o' },
        { backendId: 'derived', key: 'p' },
        { backendId: 'derived', key: 't' },
        { backendId: 'derived', key: 'u' },
        { backendId: 'derived', key: 'o' },
        { backendId: 'originals', key: 'gone' },
      ]);

      expect(recorded.map(({ backendId, key }) => `${backendId}:${key}`).toSorted()).toEqual([
        'derived:p',
        'derived:t',
        'derived:u',
        'originals:o',
      ]);
      await expect(sut.getRecorded([])).resolves.toEqual([]);
    });
  });

  describe('remove and recordFailure', () => {
    it('should remove registrations, and postpone the ones that failed', async () => {
      const { sut, db } = await setup();
      await sut.register([
        { backendId: 'derived', key: 'a', notBefore: daysFromNow(-1), isOriginal: false },
        { backendId: 'derived', key: 'b', notBefore: daysFromNow(-1), isOriginal: false },
      ]);
      const [a, b] = await sut.getDue({ now: new Date(), originalsDelayDays: 360, limit: 10 });

      await sut.remove([a.id]);
      await sut.recordFailure([b.id], 'access denied', new Date());
      await sut.recordFailure([b.id], 'access denied', new Date());

      const rows = await db.selectFrom('storage_deletion').selectAll().execute();
      expect(rows).toEqual([expect.objectContaining({ key: 'b', attempts: 2, lastError: 'access denied' })]);
      expect(rows[0].notBefore.getTime()).toBeGreaterThan(Date.now() + 60 * 60 * 1000);
      await expect(sut.getDue({ now: new Date(), originalsDelayDays: 360, limit: 10 })).resolves.toEqual([]);
    });
  });

  describe('registerUserFiles', () => {
    it('should register the files of a user on storage backends, originals with what recovering them needs', async () => {
      const { sut, ctx, db } = await setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const checksum = Buffer.from('0123456789abcdef0123', 'hex');
      const encryption = Buffer.from('0102', 'hex');
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        originalFileName: 'IMG_1.jpg',
        originalPath: '/data/upload/IMG_1.jpg',
        originalFile: { backendId: 'originals', key: 'original', size: 10, checksum, encryption },
      });
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: '/p',
        backendId: 'derived',
        key: 'p',
      });
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Sidecar,
        path: '/s',
        backendId: 'originals',
        key: 's',
      });
      // on the built-in backends, which are deleted with the user's folders
      await ctx.newAsset({ ownerId: user.id });
      await ctx.get(UserRepository).updateProfileImage(user.id, {
        profileImagePath: '/data/u.jpg',
        profileImageFile: { backendId: 'derived', key: 'u' },
        profileChangedAt: new Date(),
      });
      await ctx.newAsset({ ownerId: other.id, originalFile: { backendId: 'originals', key: 'other' } });

      const originalsNotBefore = daysFromNow(360);
      const derivedNotBefore = daysFromNow(30);
      await sut.registerUserFiles(user.id, { derivedBackendId: 'derived', originalsNotBefore, derivedNotBefore });
      // registering again changes nothing
      await sut.registerUserFiles(user.id, { derivedBackendId: 'derived', originalsNotBefore, derivedNotBefore });

      const rows = await db.selectFrom('storage_deletion').selectAll().orderBy('key').execute();
      expect(rows.map(({ backendId, key, isOriginal }) => ({ backendId, key, isOriginal }))).toEqual([
        { backendId: 'originals', key: 'original', isOriginal: true },
        { backendId: 'derived', key: 'p', isOriginal: false },
        { backendId: 'originals', key: 's', isOriginal: true },
        { backendId: 'derived', key: 'u', isOriginal: false },
      ]);
      const [original, preview, sidecar] = rows;
      expect(original).toMatchObject({
        ownerId: user.id,
        originalFileName: 'IMG_1.jpg',
        originalPath: '/data/upload/IMG_1.jpg',
        fileCreatedAt: asset.fileCreatedAt,
        size: 10,
        checksum,
        encryption,
        notBefore: originalsNotBefore,
      });
      expect(preview).toMatchObject({ notBefore: derivedNotBefore, ownerId: null });
      expect(sidecar).toMatchObject({ notBefore: originalsNotBefore });
    });
  });

  describe('countStoredOriginals', () => {
    it('should count the originals on storage backends', async () => {
      const { sut, ctx } = await setup();
      const { user } = await ctx.newUser();
      await ctx.newAsset({ ownerId: user.id, originalFile: { backendId: 'originals', key: 'a' } });
      await ctx.newAsset({ ownerId: user.id, originalFile: { backendId: 'originals', key: 'b' } });
      await ctx.newAsset({ ownerId: user.id });

      await expect(sut.countStoredOriginals()).resolves.toBe(2);
    });
  });

  describe('listOriginals and countPending', () => {
    it('should list recoverable originals, the most recently deleted first, a page at a time', async () => {
      const { sut } = await setup();
      const owner = '00000000-0000-4000-8000-000000000001';
      const other = '00000000-0000-4000-8000-000000000002';
      await sut.register([
        ...[1, 2, 3].map((day) => ({
          backendId: 'originals',
          key: `day-${day}`,
          notBefore: daysFromNow(300),
          isOriginal: true,
          createdAt: daysFromNow(-day),
          ownerId: owner,
          originalFileName: `IMG_${day}.jpg`,
        })),
        {
          backendId: 'originals',
          key: 'other',
          notBefore: daysFromNow(300),
          isOriginal: true,
          ownerId: other,
          originalFileName: 'IMG_other.jpg',
        },
        // a sidecar is not recoverable as a photo
        { backendId: 'originals', key: 'sidecar', notBefore: daysFromNow(300), isOriginal: true },
        { backendId: 'derived', key: 'preview', notBefore: daysFromNow(30), isOriginal: false },
      ]);

      const first = await sut.listOriginals({ ownerId: owner, limit: 2 });
      expect(first.map(({ key }) => key)).toEqual(['day-1', 'day-2']);
      const second = await sut.listOriginals({ ownerId: owner, after: first[1], limit: 2 });
      expect(second.map(({ key }) => key)).toEqual(['day-3']);
      await expect(sut.listOriginals({ limit: 10 })).resolves.toHaveLength(4);

      await expect(sut.countPending()).resolves.toEqual({ originals: 5, files: 6 });
      const [row] = first;
      await expect(sut.get(row.id)).resolves.toMatchObject({ key: 'day-1', originalFileName: 'IMG_1.jpg' });
    });
  });
});
