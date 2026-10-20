import { Kysely } from 'kysely';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetFileType, JobStatus } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { StorageService } from 'src/services/storage.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(StorageService, {
    database: db || defaultDatabase,
    real: [AssetRepository, DatabaseRepository, SystemMetadataRepository],
    mock: [StorageRepository, ConfigRepository, LoggingRepository],
  });
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(StorageService.name, () => {
  describe('onBoostrap', () => {
    it('should work', async () => {
      const { sut, ctx } = setup();

      const configMock = ctx.getMock(ConfigRepository);
      configMock.getEnv.mockReturnValue(mockEnvData({}));

      const storageMock = ctx.getMock(StorageRepository);
      storageMock.mkdirSync.mockReturnValue(void 0);
      storageMock.existsSync.mockReturnValue(true);
      storageMock.createFile.mockResolvedValue(void 0);
      storageMock.overwriteFile.mockResolvedValue(void 0);
      storageMock.readFile.mockResolvedValue(Buffer.from('test content'));

      await expect(sut.onBootstrap()).resolves.toBeUndefined();
    });
  });

  describe('handleFileLocationBackfill', () => {
    beforeAll(() => {
      StorageCore.setMediaLocation('/data');
    });

    afterAll(() => {
      StorageCore.reset();
    });

    it('should assign a location to every file without one', async () => {
      const { sut, ctx } = setup(await getKyselyDB());
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const insert = (type: AssetFileType, path: string) =>
        ctx.database
          .insertInto('asset_file')
          .values({ assetId: asset.id, type, path })
          .returning(['id'])
          .executeTakeFirstOrThrow();
      const media = await insert(AssetFileType.Preview, '/data/thumbs/user/preview.jpeg');
      const host = await insert(AssetFileType.Thumbnail, '/mnt/external/thumbnail.webp');
      const unusable = await insert(AssetFileType.Sidecar, 'relative/photo.jpg.xmp');

      await expect(sut.handleFileLocationBackfill()).resolves.toBe(JobStatus.Success);

      const files = await ctx.database
        .selectFrom('asset_file')
        .select(['id', 'backendId', 'key'])
        .where('assetId', '=', asset.id)
        .execute();
      expect(files).toEqual(
        expect.arrayContaining([
          { id: media.id, backendId: 'media', key: 'thumbs/user/preview.jpeg' },
          { id: host.id, backendId: 'host', key: 'mnt/external/thumbnail.webp' },
          { id: unusable.id, backendId: null, key: null },
        ]),
      );
      await expect(ctx.get(AssetRepository).getFilesWithoutLocation({ limit: 10 })).resolves.toEqual([
        { id: unusable.id, path: 'relative/photo.jpg.xmp' },
      ]);
    });

    it('should only assign a shared path under the media location to one file', async () => {
      const { sut, ctx } = setup(await getKyselyDB());
      const { user } = await ctx.newUser();
      const { asset: first } = await ctx.newAsset({ ownerId: user.id });
      const { asset: second } = await ctx.newAsset({ ownerId: user.id });
      await ctx.database
        .insertInto('asset_file')
        .values([
          { assetId: first.id, type: AssetFileType.Preview, path: '/data/shared.jpeg' },
          { assetId: second.id, type: AssetFileType.Preview, path: '/data/shared.jpeg' },
        ])
        .execute();

      await expect(sut.handleFileLocationBackfill()).resolves.toBe(JobStatus.Success);

      const files = await ctx.database.selectFrom('asset_file').select(['backendId', 'key']).execute();
      expect(files).toHaveLength(2);
      expect(files).toEqual(
        expect.arrayContaining([
          { backendId: 'media', key: 'shared.jpeg' },
          { backendId: null, key: null },
        ]),
      );
    });

    it('should assign a shared host path to every file', async () => {
      const { sut, ctx } = setup(await getKyselyDB());
      const { user } = await ctx.newUser();
      const { asset: first } = await ctx.newAsset({ ownerId: user.id });
      const { asset: second } = await ctx.newAsset({ ownerId: user.id });
      await ctx.database
        .insertInto('asset_file')
        .values([
          { assetId: first.id, type: AssetFileType.Sidecar, path: '/mnt/external/IMG_1.jpg.xmp' },
          { assetId: second.id, type: AssetFileType.Sidecar, path: '/mnt/external/IMG_1.jpg.xmp' },
        ])
        .execute();

      await expect(sut.handleFileLocationBackfill()).resolves.toBe(JobStatus.Success);

      await expect(ctx.database.selectFrom('asset_file').select(['backendId', 'key']).execute()).resolves.toEqual([
        { backendId: 'host', key: 'mnt/external/IMG_1.jpg.xmp' },
        { backendId: 'host', key: 'mnt/external/IMG_1.jpg.xmp' },
      ]);
    });

    it('should record the original file of assets that have none', async () => {
      const { sut, ctx } = setup(await getKyselyDB());
      const { user } = await ctx.newUser();
      const { asset: uploaded } = await ctx.newAsset({ ownerId: user.id, originalPath: '/data/upload/IMG_1.jpg' });
      const { asset: external } = await ctx.newAsset({ ownerId: user.id, originalPath: '/mnt/photos/IMG_2.jpg' });
      await ctx.database.deleteFrom('asset_original_file').execute();

      await expect(sut.handleFileLocationBackfill()).resolves.toBe(JobStatus.Success);

      await expect(
        ctx.database.selectFrom('asset_original_file').select(['assetId', 'backendId', 'key']).execute(),
      ).resolves.toEqual(
        expect.arrayContaining([
          { assetId: uploaded.id, backendId: 'media', key: 'upload/IMG_1.jpg' },
          { assetId: external.id, backendId: 'host', key: 'mnt/photos/IMG_2.jpg' },
        ]),
      );
      await expect(ctx.get(AssetRepository).hasAssetsWithoutOriginalFile()).resolves.toBe(false);
    });
  });
});
