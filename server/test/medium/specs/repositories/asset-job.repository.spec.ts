import { Kysely } from 'kysely';
import { AssetFileType, AssetType, AssetVisibility } from 'src/enum.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { newEmbedding } from 'test/small.factory.js';
import { getKyselyDB, getTestKyselyDB } from 'test/utils.js';

const consume = async <T>(generator: AsyncIterableIterator<T>) => {
  const values: T[] = await Array.fromAsync(generator);

  return values;
};

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(AssetJobRepository) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AssetJobRepository.name, () => {
  describe('getProcessingCounts', () => {
    it('should count, of the photos each step is for, those it is done for', async () => {
      const { ctx, sut } = setup(await getTestKyselyDB());
      const { user } = await ctx.newUser();
      const at = new Date();
      const photo = async (
        dto: Parameters<typeof ctx.newAsset>[0],
        {
          status = {},
          files = [],
          editedPreview = false,
          embedding = false,
        }: {
          status?: { metadataExtractedAt?: Date; facesRecognizedAt?: Date; ocrAt?: Date; duplicatesDetectedAt?: Date };
          files?: AssetFileType[];
          editedPreview?: boolean;
          embedding?: boolean;
        } = {},
      ) => {
        const { asset } = await ctx.newAsset({ ownerId: user.id, ...dto });
        await ctx.get(AssetRepository).upsertJobStatus({
          assetId: asset.id,
          metadataExtractedAt: null,
          facesRecognizedAt: null,
          ocrAt: null,
          duplicatesDetectedAt: null,
          ...status,
        });
        for (const type of files) {
          await ctx.newAssetFile({ assetId: asset.id, type, path: `${asset.id}-${type}.jpg` });
        }
        if (editedPreview) {
          await ctx.newAssetFile({
            assetId: asset.id,
            type: AssetFileType.Preview,
            path: `${asset.id}-e.jpg`,
            isEdited: true,
          });
        }
        if (embedding) {
          await ctx.database
            .insertInto('smart_search')
            .values({ assetId: asset.id, embedding: newEmbedding() })
            .execute();
        }
      };
      const everything = {
        status: { metadataExtractedAt: at, facesRecognizedAt: at, ocrAt: at, duplicatesDetectedAt: at },
        files: [AssetFileType.Thumbnail, AssetFileType.Preview],
        embedding: true,
      };
      await photo({}, everything);
      await photo({}, { status: { metadataExtractedAt: at } });
      await photo({}, { status: { metadataExtractedAt: at }, files: everything.files, embedding: true });
      // the preview of an edit is not the photo's
      await photo({}, { editedPreview: true });
      // not counted: deleted, or the video of a live photo
      await photo({ deletedAt: at }, everything);
      await photo({ visibility: AssetVisibility.Hidden }, everything);

      await expect(sut.getProcessingCounts()).resolves.toEqual({
        all: 4,
        metadata: 3,
        thumbnails: 2,
        withPreview: 2,
        smartSearch: 2,
        faces: 1,
        ocr: 1,
        withEmbedding: 2,
        duplicates: 1,
      });
    });
  });

  describe('streamLongImages', () => {
    it('should stream the images longer than a ratio, either way', async () => {
      const { ctx, sut } = setup(await getTestKyselyDB());
      const { user } = await ctx.newUser();
      const screenshot = await ctx.newAsset({ ownerId: user.id, width: 1080, height: 20_000 });
      const panorama = await ctx.newAsset({ ownerId: user.id, width: 30_000, height: 3000 });
      await ctx.newAsset({ ownerId: user.id, width: 1080, height: 6000 });
      await ctx.newAsset({ ownerId: user.id, width: 4032, height: 3024 });
      await ctx.newAsset({ ownerId: user.id, width: null, height: null });
      await ctx.newAsset({ ownerId: user.id, width: 1080, height: 20_000, type: AssetType.Video });
      await ctx.newAsset({ ownerId: user.id, width: 1080, height: 20_000, deletedAt: new Date() });

      const assets = await consume(sut.streamLongImages(16_000_000 / (1440 * 1440)));

      expect(assets.map(({ id }) => id).toSorted()).toEqual([screenshot.asset.id, panorama.asset.id].toSorted());
    });
  });

  describe('streamForThumbnailJob', () => {
    it('should work', async () => {
      const { sut } = setup();
      const stream = sut.streamForThumbnailJob({ force: false, fullsizeEnabled: false });
      await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
    });

    it('should queue an asset with missing thumbnails', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newJobStatus({ assetId: asset.id, metadataExtractedAt: new Date() });

      const stream = sut.streamForThumbnailJob({ force: false, fullsizeEnabled: false });
      await expect(consume(stream)).resolves.toEqual([expect.objectContaining({ id: asset.id })]);
    });

    it('should skip assets without missing thumbnails', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, thumbhash: Buffer.from('fake-thumbhash-buffer') });
      await ctx.newJobStatus({ assetId: asset.id, metadataExtractedAt: new Date() });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Thumbnail, path: 'thumbnail.jpg' });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: 'preview.jpg' });

      const stream = sut.streamForThumbnailJob({ force: false, fullsizeEnabled: false });
      await expect(consume(stream)).resolves.not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: asset.id })]),
      );
    });

    it('should queue assets with a missing full size', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        thumbhash: Buffer.from('fake-thumbhash-buffer'),
        originalFileName: 'photo.cr2',
      });
      await ctx.newJobStatus({ assetId: asset.id, metadataExtractedAt: new Date() });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Thumbnail, path: 'thumbnail.jpg' });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: 'preview.jpg' });

      const stream = sut.streamForThumbnailJob({ force: false, fullsizeEnabled: true });
      await expect(consume(stream)).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: asset.id })]),
      );
    });

    it('should skip assets with after they have full size previews', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, thumbhash: Buffer.from('fake-thumbhash-buffer') });
      await ctx.newJobStatus({ assetId: asset.id, metadataExtractedAt: new Date() });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Thumbnail, path: 'thumbnail.jpg' });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: 'preview.jpg' });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.FullSize, path: 'fullsize.jpg' });

      const stream = sut.streamForThumbnailJob({ force: false, fullsizeEnabled: true });
      await expect(consume(stream)).resolves.not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: asset.id })]),
      );
    });

    it('should skip assets with web-compatible originals', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        thumbhash: Buffer.from('fake-thumbhash-buffer'),
        originalFileName: 'photo.jpg',
      });
      await ctx.newJobStatus({ assetId: asset.id, metadataExtractedAt: new Date() });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Thumbnail, path: 'thumbnail.jpg' });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: 'preview.jpg' });

      const stream = sut.streamForThumbnailJob({ force: false, fullsizeEnabled: true });
      await expect(consume(stream)).resolves.not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: asset.id })]),
      );
    });
  });

  describe('getForOcr', () => {
    it('should not return the edited preview file', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: 'preview_edited.jpg',
        isEdited: true,
      });
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: 'preview_unedited.jpg',
        isEdited: false,
      });

      const result = await sut.getForOcr(asset.id);

      expect(result).toEqual(
        expect.objectContaining({
          previewFile: {
            path: 'preview_unedited.jpg',
            backendId: 'host',
            key: 'preview_unedited.jpg',
            size: null,
            encryption: null,
          },
        }),
      );
    });
  });

  describe('file locations in JSON', () => {
    // the storage backend repository decodes exactly this form (see its unit tests)
    it('should return the encryption header of files as hex text', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const header = Buffer.from('0102fe', 'hex');
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        originalFile: { backendId: 'host', key: 'original.jpg', size: 3, encryption: header },
      });
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: 'preview.jpg',
        encryption: header,
      });

      await ctx.newExif({ assetId: asset.id, make: 'Canon' });

      const result = await sut.getForGenerateThumbnailJob(asset.id);

      expect(result?.originalFile).toEqual({
        backendId: 'host',
        key: 'original.jpg',
        size: 3,
        encryption: String.raw`\x0102fe`,
      });
      expect(result?.files).toEqual([expect.objectContaining({ encryption: String.raw`\x0102fe` })]);
    });
  });
});
