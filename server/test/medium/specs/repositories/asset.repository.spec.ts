import { Kysely } from 'kysely';
import { AssetFileType, AssetOrder, AssetOrderBy, AssetVisibility } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { MediumTestContext, mediumFactory, newMediumService } from 'test/medium.factory.js';
import { factory, newUuid } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(AssetRepository) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

// Metadata extraction is repeatable: probing improves, files get repaired,
// and a re-run has to be able to correct what an earlier run stored.
const audioRow = (assetId: string, n: number) => ({
  assetId,
  bitrate: 100_000 + n,
  index: n,
  profile: n,
  codecName: `codec-${n}`,
});

const videoRow = (assetId: string, n: number) => ({
  assetId,
  bitrate: 200_000 + n,
  frameCount: 300 + n,
  timeBase: 600 + n,
  index: n,
  profile: n,
  level: n,
  colorPrimaries: n,
  colorTransfer: n,
  colorMatrix: n,
  dvProfile: n,
  dvLevel: n,
  dvBlSignalCompatibilityId: n,
  codecName: `vcodec-${n}`,
  formatName: `format-${n}`,
  formatLongName: `format long ${n}`,
  pixelFormat: `pixfmt-${n}`,
});

const keyframeRow = (assetId: string, n: number) => ({
  assetId,
  pts: [n],
  accDuration: [n],
  ownDuration: [n],
  totalDuration: 1000 + n,
  packetCount: 10 + n,
  outputFrames: 20 + n,
});

describe(AssetRepository.name, () => {
  describe('getTimeBucket', () => {
    it('should order assets by local day first and fileCreatedAt within each day', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });

      const [{ asset: previousLocalDayAsset }, { asset: nextLocalDayEarlierAsset }, { asset: nextLocalDayLaterAsset }] =
        await Promise.all([
          ctx.newAsset({
            ownerId: user.id,
            fileCreatedAt: new Date('2026-03-09T00:30:00.000Z'),
            localDateTime: new Date('2026-03-08T22:30:00.000Z'),
          }),
          ctx.newAsset({
            ownerId: user.id,
            fileCreatedAt: new Date('2026-03-08T23:30:00.000Z'),
            localDateTime: new Date('2026-03-09T01:30:00.000Z'),
          }),
          ctx.newAsset({
            ownerId: user.id,
            fileCreatedAt: new Date('2026-03-08T23:45:00.000Z'),
            localDateTime: new Date('2026-03-09T01:45:00.000Z'),
          }),
        ]);

      await Promise.all([
        ctx.newExif({ assetId: previousLocalDayAsset.id, timeZone: 'UTC-2' }),
        ctx.newExif({ assetId: nextLocalDayEarlierAsset.id, timeZone: 'UTC+2' }),
        ctx.newExif({ assetId: nextLocalDayLaterAsset.id, timeZone: 'UTC+2' }),
      ]);

      const descendingBucket = await sut.getTimeBucket(
        '2026-03-01',
        { order: AssetOrder.Desc, userIds: [user.id], visibility: AssetVisibility.Timeline },
        auth,
      );
      expect(JSON.parse(descendingBucket.assets)).toEqual(
        expect.objectContaining({
          id: [nextLocalDayLaterAsset.id, nextLocalDayEarlierAsset.id, previousLocalDayAsset.id],
        }),
      );

      const ascendingBucket = await sut.getTimeBucket(
        '2026-03-01',
        { order: AssetOrder.Asc, userIds: [user.id], visibility: AssetVisibility.Timeline },
        auth,
      );
      expect(JSON.parse(ascendingBucket.assets)).toEqual(
        expect.objectContaining({
          id: [previousLocalDayAsset.id, nextLocalDayEarlierAsset.id, nextLocalDayLaterAsset.id],
        }),
      );
    });

    it('should order assets by originalFileName when fileCreatedAt is the same (takenAt)', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });

      // create all the fake photos
      const [
        { asset: time1DSC0001Asset },
        { asset: time1DSC0002Asset },
        { asset: time2DSC0003Asset },
        { asset: time2DSC0004Asset },
      ] = await Promise.all([
        // both at 12:30AM
        ctx.newAsset({
          ownerId: user.id,
          fileCreatedAt: new Date('2026-03-09T00:30:00.000Z'),
          localDateTime: new Date('2026-03-09T00:30:00.000Z'),
          originalFileName: 'DSC0001.jpg',
        }),
        ctx.newAsset({
          ownerId: user.id,
          fileCreatedAt: new Date('2026-03-09T00:30:00.000Z'),
          localDateTime: new Date('2026-03-09T00:30:00.000Z'),
          originalFileName: 'DSC0002.jpg',
        }),
        // both at 1:45AM
        ctx.newAsset({
          ownerId: user.id,
          fileCreatedAt: new Date('2026-03-09T01:45:00.000Z'),
          localDateTime: new Date('2026-03-09T01:45:00.000Z'),
          originalFileName: 'DSC0003.jpg',
        }),
        ctx.newAsset({
          ownerId: user.id,
          fileCreatedAt: new Date('2026-03-09T01:45:00.000Z'),
          localDateTime: new Date('2026-03-09T01:45:00.000Z'),
          originalFileName: 'DSC0004.jpg',
        }),
      ]);

      // even though im not gonna do anything with these it's required!
      await Promise.all([
        ctx.newExif({ assetId: time1DSC0001Asset.id, timeZone: 'UTC+2' }),
        ctx.newExif({ assetId: time1DSC0002Asset.id, timeZone: 'UTC+2' }),
        ctx.newExif({ assetId: time2DSC0003Asset.id, timeZone: 'UTC+2' }),
        ctx.newExif({ assetId: time2DSC0004Asset.id, timeZone: 'UTC+2' }),
      ]);

      // check the values given by the bucket when descending
      const descendingBucket = await sut.getTimeBucket(
        '2026-03-01',
        {
          order: AssetOrder.Desc,
          userIds: [user.id],
          visibility: AssetVisibility.Timeline,
          orderBy: AssetOrderBy.TakenAt,
        },
        auth,
      );
      // make sure they're ordered correctly
      expect(JSON.parse(descendingBucket.assets)).toEqual(
        expect.objectContaining({
          id: [time2DSC0004Asset.id, time2DSC0003Asset.id, time1DSC0002Asset.id, time1DSC0001Asset.id],
        }),
      );

      // now do the same when ascending
      const ascendingBucket = await sut.getTimeBucket(
        '2026-03-01',
        {
          order: AssetOrder.Asc,
          userIds: [user.id],
          visibility: AssetVisibility.Timeline,
          orderBy: AssetOrderBy.TakenAt,
        },
        auth,
      );
      expect(JSON.parse(ascendingBucket.assets)).toEqual(
        expect.objectContaining({
          id: [time1DSC0001Asset.id, time1DSC0002Asset.id, time2DSC0003Asset.id, time2DSC0004Asset.id],
        }),
      );
    });

    it('should order assets by originalFileName when fileCreatedAt is the same (createdAt)', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });

      // create all the fake photos
      const [
        { asset: time1DSC0001Asset },
        { asset: time1DSC0002Asset },
        { asset: time2DSC0003Asset },
        { asset: time2DSC0004Asset },
      ] = await Promise.all([
        // createdAt = uploadedAt, fileCreatedAt = file metadata
        // both at 12:30AM
        ctx.newAsset({
          ownerId: user.id,
          fileCreatedAt: new Date('2026-03-09T00:30:00.000Z'),
          localDateTime: new Date('2026-03-09T00:30:00.000Z'),
          createdAt: new Date('2026-03-09T00:30:00.000Z'),
          originalFileName: 'DSC0001.jpg',
        }),
        ctx.newAsset({
          ownerId: user.id,
          fileCreatedAt: new Date('2026-03-09T00:30:00.000Z'),
          localDateTime: new Date('2026-03-09T00:30:00.000Z'),
          createdAt: new Date('2026-03-09T00:30:00.000Z'),
          originalFileName: 'DSC0002.jpg',
        }),
        // both at 1:45AM
        ctx.newAsset({
          ownerId: user.id,
          fileCreatedAt: new Date('2026-03-09T01:45:00.000Z'),
          localDateTime: new Date('2026-03-09T01:45:00.000Z'),
          createdAt: new Date('2026-03-09T01:45:00.000Z'),
          originalFileName: 'DSC0003.jpg',
        }),
        ctx.newAsset({
          ownerId: user.id,
          fileCreatedAt: new Date('2026-03-09T01:45:00.000Z'),
          localDateTime: new Date('2026-03-09T01:45:00.000Z'),
          createdAt: new Date('2026-03-09T01:45:00.000Z'),
          originalFileName: 'DSC0004.jpg',
        }),
      ]);

      // even though im not gonna do anything with these it's required!
      await Promise.all([
        ctx.newExif({ assetId: time1DSC0001Asset.id, timeZone: 'UTC+2' }),
        ctx.newExif({ assetId: time1DSC0002Asset.id, timeZone: 'UTC+2' }),
        ctx.newExif({ assetId: time2DSC0003Asset.id, timeZone: 'UTC+2' }),
        ctx.newExif({ assetId: time2DSC0004Asset.id, timeZone: 'UTC+2' }),
      ]);

      // check the values given by the bucket when descending
      const descendingBucket = await sut.getTimeBucket(
        '2026-03-01',
        {
          order: AssetOrder.Desc,
          userIds: [user.id],
          visibility: AssetVisibility.Timeline,
          orderBy: AssetOrderBy.CreatedAt,
        },
        auth,
      );
      // make sure they're ordered correctly
      expect(JSON.parse(descendingBucket.assets)).toEqual(
        expect.objectContaining({
          id: [time2DSC0004Asset.id, time2DSC0003Asset.id, time1DSC0002Asset.id, time1DSC0001Asset.id],
        }),
      );

      // now do the same when ascending
      const ascendingBucket = await sut.getTimeBucket(
        '2026-03-01',
        {
          order: AssetOrder.Asc,
          userIds: [user.id],
          visibility: AssetVisibility.Timeline,
          orderBy: AssetOrderBy.CreatedAt,
        },
        auth,
      );
      expect(JSON.parse(ascendingBucket.assets)).toEqual(
        expect.objectContaining({
          id: [time1DSC0001Asset.id, time1DSC0002Asset.id, time2DSC0003Asset.id, time2DSC0004Asset.id],
        }),
      );
    });
  });

  describe('upsertExif', () => {
    it('should replace stored audio metadata on a second extraction', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await sut.upsertExif({
        exif: { assetId: asset.id, description: 'first' },
        audio: audioRow(asset.id, 2),
        lockedPropertiesBehavior: 'skip',
      });
      await sut.upsertExif({
        exif: { assetId: asset.id, description: 'second' },
        audio: audioRow(asset.id, 1),
        lockedPropertiesBehavior: 'skip',
      });

      await expect(
        ctx.database.selectFrom('asset_audio').selectAll().where('assetId', '=', asset.id).executeTakeFirstOrThrow(),
      ).resolves.toEqual(audioRow(asset.id, 1));
    });

    it('should replace stored video metadata on a second extraction', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await sut.upsertExif({
        exif: { assetId: asset.id, description: 'first' },
        video: videoRow(asset.id, 2),
        lockedPropertiesBehavior: 'skip',
      });
      await sut.upsertExif({
        exif: { assetId: asset.id, description: 'second' },
        video: videoRow(asset.id, 1),
        lockedPropertiesBehavior: 'skip',
      });

      await expect(
        ctx.database.selectFrom('asset_video').selectAll().where('assetId', '=', asset.id).executeTakeFirstOrThrow(),
      ).resolves.toEqual(videoRow(asset.id, 1));
    });

    it('should replace stored keyframe metadata on a second extraction', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await sut.upsertExif({
        exif: { assetId: asset.id, description: 'first' },
        keyframes: keyframeRow(asset.id, 2),
        lockedPropertiesBehavior: 'skip',
      });
      await sut.upsertExif({
        exif: { assetId: asset.id, description: 'second' },
        keyframes: keyframeRow(asset.id, 1),
        lockedPropertiesBehavior: 'skip',
      });

      await expect(
        ctx.database.selectFrom('asset_keyframe').selectAll().where('assetId', '=', asset.id).executeTakeFirstOrThrow(),
      ).resolves.toEqual(keyframeRow(asset.id, 1));
    });

    // A probe that could not read a stream sends no object at all, and that must
    // not be read as "delete what is already known".
    it('should leave stored media metadata alone when an extraction omits it', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await sut.upsertExif({
        exif: { assetId: asset.id, description: 'first' },
        audio: audioRow(asset.id, 2),
        lockedPropertiesBehavior: 'skip',
      });
      await sut.upsertExif({
        exif: { assetId: asset.id, description: 'second' },
        lockedPropertiesBehavior: 'skip',
      });

      await expect(
        ctx.database.selectFrom('asset_audio').selectAll().where('assetId', '=', asset.id).executeTakeFirstOrThrow(),
      ).resolves.toEqual(audioRow(asset.id, 2));
    });
    it('should append to locked columns', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({
        assetId: asset.id,
        dateTimeOriginal: '2023-11-19T18:11:00',
        lockedProperties: ['dateTimeOriginal'],
      });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: ['dateTimeOriginal'] });

      await sut.upsertExif({
        exif: { assetId: asset.id, lockedProperties: ['description'] },
        lockedPropertiesBehavior: 'append',
      });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: ['description', 'dateTimeOriginal'] });
    });

    it('should deduplicate locked columns', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({
        assetId: asset.id,
        dateTimeOriginal: '2023-11-19T18:11:00',
        lockedProperties: ['dateTimeOriginal', 'description'],
      });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: ['dateTimeOriginal', 'description'] });

      await sut.upsertExif({
        exif: { assetId: asset.id, lockedProperties: ['description'] },
        lockedPropertiesBehavior: 'append',
      });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: ['description', 'dateTimeOriginal'] });
    });
  });

  describe('unlockProperties', () => {
    it('should unlock one property', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({
        assetId: asset.id,
        dateTimeOriginal: '2023-11-19T18:11:00',
        lockedProperties: ['dateTimeOriginal', 'description'],
      });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: ['dateTimeOriginal', 'description'] });

      await sut.unlockProperties(asset.id, ['dateTimeOriginal']);

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: ['description'] });
    });

    it('should unlock all properties', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({
        assetId: asset.id,
        dateTimeOriginal: '2023-11-19T18:11:00',
        lockedProperties: ['dateTimeOriginal', 'description'],
      });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: ['dateTimeOriginal', 'description'] });

      await sut.unlockProperties(asset.id, ['description', 'dateTimeOriginal']);

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: null });
    });
  });

  describe('createAll', () => {
    it('should return an empty array when given an empty input', async () => {
      const { sut } = setup();
      await expect(sut.createAll([])).resolves.toStrictEqual([]);
    });
  });
});

const newAssetWithoutFileLocation = async (ctx: MediumTestContext, path: string) => {
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id });
  const file = await ctx.database
    .insertInto('asset_file')
    .values({ assetId: asset.id, type: AssetFileType.Preview, path })
    .returning(['id'])
    .executeTakeFirstOrThrow();
  return { asset, fileId: file.id };
};

const getFile = (ctx: MediumTestContext, id: string) =>
  ctx.database
    .selectFrom('asset_file')
    .select(['backendId', 'key', 'path'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();

describe('asset file storage locations', () => {
  it('should store the location when upserting a file and update it when the file moves', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });

    await sut.upsertFile({
      assetId: asset.id,
      type: AssetFileType.Thumbnail,
      path: '/data/thumbs/old.webp',
      backendId: 'media',
      key: `thumbs/${asset.id}/old.webp`,
    });
    await sut.upsertFile({
      assetId: asset.id,
      type: AssetFileType.Thumbnail,
      path: '/data/thumbs/new.webp',
      backendId: 'media',
      key: `thumbs/${asset.id}/new.webp`,
    });

    await expect(
      ctx.database
        .selectFrom('asset_file')
        .select(['path', 'backendId', 'key'])
        .where('assetId', '=', asset.id)
        .execute(),
    ).resolves.toEqual([{ path: '/data/thumbs/new.webp', backendId: 'media', key: `thumbs/${asset.id}/new.webp` }]);
  });

  it('should not allow two files at the same location', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { asset: first } = await ctx.newAsset({ ownerId: user.id });
    const { asset: second } = await ctx.newAsset({ ownerId: user.id });
    const key = `upload/${first.id}/shared.jpg`;

    await sut.upsertFile({ assetId: first.id, type: AssetFileType.Preview, path: '/data/a', backendId: 'media', key });

    await expect(
      sut.upsertFile({ assetId: second.id, type: AssetFileType.Preview, path: '/data/b', backendId: 'media', key }),
    ).rejects.toThrow('asset_file_backendId_key_idx');
  });

  it('should allow several files to share a host file', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { asset: first } = await ctx.newAsset({ ownerId: user.id });
    const { asset: second } = await ctx.newAsset({ ownerId: user.id });
    const path = `/mnt/external/${first.id}/IMG_1.jpg.xmp`;
    const file = { type: AssetFileType.Sidecar, path, backendId: 'host', key: path.slice(1) };

    await sut.upsertFile({ assetId: first.id, ...file });
    await sut.upsertFile({ assetId: second.id, ...file });

    await expect(
      ctx.database.selectFrom('asset_file').select('assetId').where('key', '=', file.key).execute(),
    ).resolves.toHaveLength(2);
  });

  it('should not allow a location on a storage backend that does not exist', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });

    await expect(
      sut.upsertFile({ assetId: asset.id, type: AssetFileType.Preview, path: '/x', backendId: 'missing', key: 'x' }),
    ).rejects.toThrow('asset_file_backendId_fkey');
  });

  it('should only return files without a location, ordered by id and paged after a given id', async () => {
    const db = await getKyselyDB();
    const { ctx, sut } = setup(db);
    const files = [
      await newAssetWithoutFileLocation(ctx, '/data/upload/1.jpg'),
      await newAssetWithoutFileLocation(ctx, '/data/upload/2.jpg'),
      await newAssetWithoutFileLocation(ctx, '/data/upload/3.jpg'),
    ];
    const { user } = await ctx.newUser();
    const { asset: located } = await ctx.newAsset({ ownerId: user.id });
    await ctx.newAssetFile({ assetId: located.id, type: AssetFileType.Preview, path: '/data/upload/located.jpg' });
    const ids = files.map(({ fileId }) => fileId).toSorted();

    await expect(sut.hasFilesWithoutLocation()).resolves.toBe(true);
    await expect(sut.getFilesWithoutLocation({ limit: 2 })).resolves.toEqual([
      { id: ids[0], path: expect.any(String) },
      { id: ids[1], path: expect.any(String) },
    ]);
    await expect(sut.getFilesWithoutLocation({ afterId: ids[1], limit: 2 })).resolves.toEqual([
      { id: ids[2], path: expect.any(String) },
    ]);
  });

  it('should report when every file has a location', async () => {
    const db = await getKyselyDB();
    const { ctx, sut } = setup(db);
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: '/data/upload/located.jpg' });

    await expect(sut.hasFilesWithoutLocation()).resolves.toBe(false);
    await expect(sut.getFilesWithoutLocation({ limit: 10 })).resolves.toEqual([]);
  });

  it('should set locations, skipping files that already have one and locations that belong to another file', async () => {
    const { ctx, sut } = setup();
    const { fileId: first } = await newAssetWithoutFileLocation(ctx, '/data/upload/first.jpg');
    const { fileId: second } = await newAssetWithoutFileLocation(ctx, '/data/upload/second.jpg');
    const { user } = await ctx.newUser();
    const { asset: other } = await ctx.newAsset({ ownerId: user.id });
    const takenKey = `upload/${second}/taken.jpg`;
    await ctx.newAssetFile({
      assetId: other.id,
      type: AssetFileType.Preview,
      path: '/data/taken.jpg',
      backendId: 'media',
      key: takenKey,
    });
    const { fileId: alreadyLocated } = await newAssetWithoutFileLocation(ctx, '/data/upload/third.jpg');
    await ctx.database
      .updateTable('asset_file')
      .set({ backendId: 'host', key: `already/${alreadyLocated}` })
      .where('id', '=', alreadyLocated)
      .execute();

    await expect(
      sut.setFileLocations([
        { id: first, backendId: 'media', key: `upload/${first}/first.jpg` },
        { id: second, backendId: 'media', key: takenKey },
        { id: alreadyLocated, backendId: 'media', key: `upload/${alreadyLocated}/third.jpg` },
      ]),
    ).resolves.toBe(1);

    await expect(getFile(ctx, first)).resolves.toEqual({
      backendId: 'media',
      key: `upload/${first}/first.jpg`,
      path: '/data/upload/first.jpg',
    });
    await expect(getFile(ctx, second)).resolves.toEqual({
      backendId: null,
      key: null,
      path: '/data/upload/second.jpg',
    });
    await expect(getFile(ctx, alreadyLocated)).resolves.toEqual({
      backendId: 'host',
      key: `already/${alreadyLocated}`,
      path: '/data/upload/third.jpg',
    });
  });

  it('should set a host location that already belongs to another file', async () => {
    const { ctx, sut } = setup();
    const path = `/mnt/external/${newUuid()}/IMG_1.jpg.xmp`;
    const { fileId: first } = await newAssetWithoutFileLocation(ctx, path);
    const { fileId: second } = await newAssetWithoutFileLocation(ctx, path);
    const location = { backendId: 'host', key: path.slice(1) };

    await expect(
      sut.setFileLocations([
        { id: first, ...location },
        { id: second, ...location },
      ]),
    ).resolves.toBe(2);

    await expect(getFile(ctx, first)).resolves.toEqual({ ...location, path });
    await expect(getFile(ctx, second)).resolves.toEqual({ ...location, path });
  });

  it('should do nothing when no locations are given', async () => {
    const { sut } = setup();
    await expect(sut.setFileLocations([])).resolves.toBe(0);
  });
});

const newAssetWithoutOriginalFile = async (ctx: MediumTestContext, originalPath: string) => {
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id, originalPath });
  await ctx.database.deleteFrom('asset_original_file').where('assetId', '=', asset.id).execute();
  return asset;
};

const getOriginalFile = (ctx: MediumTestContext, assetId: string) =>
  ctx.database
    .selectFrom('asset_original_file')
    .select(['backendId', 'key'])
    .where('assetId', '=', assetId)
    .executeTakeFirst();

describe('asset original files', () => {
  it('should record the original file when creating an asset', async () => {
    const { ctx } = setup();
    const { user } = await ctx.newUser();
    const key = `upload/${newUuid()}.jpg`;

    const { asset } = await ctx.newAsset({ ownerId: user.id, originalFile: { backendId: 'media', key } });

    await expect(getOriginalFile(ctx, asset.id)).resolves.toEqual({ backendId: 'media', key });
  });

  it('should not create the asset when its original file cannot be recorded', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { asset: existing } = await ctx.newAsset({ ownerId: user.id });
    const taken = await getOriginalFile(ctx, existing.id);
    const id = newUuid();

    await expect(
      sut.create({ ...mediumFactory.assetInsert({ id, ownerId: user.id }), originalFile: taken! }),
    ).rejects.toThrow('asset_original_file_backendId_key_idx');

    await expect(ctx.database.selectFrom('asset').select('id').where('id', '=', id).execute()).resolves.toEqual([]);
  });

  it('should record the original file of every asset created together', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const keys = [`mnt/${newUuid()}/a.jpg`, `mnt/${newUuid()}/b.jpg`];

    const ids = await sut.createAll(
      keys.map((key) => ({
        ...mediumFactory.assetInsert({ ownerId: user.id, originalPath: `/${key}` }),
        originalFile: { backendId: 'host', key },
      })),
    );

    expect(ids).toHaveLength(2);
    const originals = await Promise.all(ids.map((id) => getOriginalFile(ctx, id)));
    const paths = await ctx.database
      .selectFrom('asset')
      .select(['id', 'originalPath'])
      .where('id', 'in', ids)
      .execute();
    for (const [index, id] of ids.entries()) {
      expect(originals[index]).toEqual({
        backendId: 'host',
        key: paths.find((asset) => asset.id === id)!.originalPath.slice(1),
      });
    }
  });

  it('should keep the original file of a moved asset in step with its path', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const key = `library/${newUuid()}/IMG_1.jpg`;

    await sut.updateOriginalPath({
      id: asset.id,
      originalPath: `/data/${key}`,
      originalFile: { backendId: 'media', key },
    });

    await expect(getOriginalFile(ctx, asset.id)).resolves.toEqual({ backendId: 'media', key });
    await expect(
      ctx.database.selectFrom('asset').select('originalPath').where('id', '=', asset.id).executeTakeFirst(),
    ).resolves.toEqual({ originalPath: `/data/${key}` });
  });

  it('should record the original file of a moved asset that had none', async () => {
    const { ctx, sut } = setup();
    const asset = await newAssetWithoutOriginalFile(ctx, '/data/upload/old.jpg');
    const key = `library/${newUuid()}/IMG_1.jpg`;

    await sut.updateOriginalPath({
      id: asset.id,
      originalPath: `/data/${key}`,
      originalFile: { backendId: 'media', key },
    });

    await expect(getOriginalFile(ctx, asset.id)).resolves.toEqual({ backendId: 'media', key });
  });

  it('should page through assets without an original file', async () => {
    const db = await getKyselyDB();
    const { ctx, sut } = setup(db);
    const assets = [
      await newAssetWithoutOriginalFile(ctx, '/data/upload/1.jpg'),
      await newAssetWithoutOriginalFile(ctx, '/data/upload/2.jpg'),
      await newAssetWithoutOriginalFile(ctx, '/data/upload/3.jpg'),
    ];
    const { user } = await ctx.newUser();
    await ctx.newAsset({ ownerId: user.id });
    const ids = assets.map(({ id }) => id).toSorted();
    const pathOf = (id: string) => assets.find((asset) => asset.id === id)!.originalPath;

    await expect(sut.hasAssetsWithoutOriginalFile()).resolves.toBe(true);
    await expect(sut.getAssetsWithoutOriginalFile({ limit: 2 })).resolves.toEqual([
      { id: ids[0], path: pathOf(ids[0]) },
      { id: ids[1], path: pathOf(ids[1]) },
    ]);
    await expect(sut.getAssetsWithoutOriginalFile({ afterId: ids[1], limit: 2 })).resolves.toEqual([
      { id: ids[2], path: pathOf(ids[2]) },
    ]);
  });

  it('should report when every asset has an original file', async () => {
    const db = await getKyselyDB();
    const { ctx, sut } = setup(db);
    const { user } = await ctx.newUser();
    await ctx.newAsset({ ownerId: user.id });

    await expect(sut.hasAssetsWithoutOriginalFile()).resolves.toBe(false);
  });

  it('should set original files, skipping assets that have one, taken locations and deleted assets', async () => {
    const { ctx, sut } = setup();
    const first = await newAssetWithoutOriginalFile(ctx, '/data/upload/first.jpg');
    const second = await newAssetWithoutOriginalFile(ctx, '/data/upload/second.jpg');
    const { user } = await ctx.newUser();
    const { asset: located } = await ctx.newAsset({ ownerId: user.id });
    const locatedFile = await getOriginalFile(ctx, located.id);

    await expect(
      sut.setOriginalFiles([
        { id: first.id, backendId: 'media', key: `upload/${first.id}.jpg` },
        { id: second.id, ...locatedFile! },
        { id: located.id, backendId: 'media', key: `upload/${located.id}.jpg` },
        { id: newUuid(), backendId: 'media', key: `upload/${newUuid()}.jpg` },
      ]),
    ).resolves.toBe(1);

    await expect(getOriginalFile(ctx, first.id)).resolves.toEqual({
      backendId: 'media',
      key: `upload/${first.id}.jpg`,
    });
    await expect(getOriginalFile(ctx, second.id)).resolves.toBeUndefined();
    await expect(getOriginalFile(ctx, located.id)).resolves.toEqual(locatedFile);
  });

  it('should set a host original file that another asset already has', async () => {
    const { ctx, sut } = setup();
    const path = `/mnt/external/${newUuid()}/IMG_1.jpg`;
    const first = await newAssetWithoutOriginalFile(ctx, path);
    const second = await newAssetWithoutOriginalFile(ctx, path);
    const location = { backendId: 'host', key: path.slice(1) };

    await expect(
      sut.setOriginalFiles([
        { id: first.id, ...location },
        { id: second.id, ...location },
      ]),
    ).resolves.toBe(2);
  });

  it('should do nothing when no original files are given', async () => {
    const { sut } = setup();
    await expect(sut.setOriginalFiles([])).resolves.toBe(0);
  });
});
