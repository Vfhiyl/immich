import { BadRequestException } from '@nestjs/common';
import { Readable } from 'node:stream';
import { vitest } from 'vitest';
import { DownloadResponseDto } from 'src/dtos/download.dto.js';
import { StorageBackendDriver, StorageBackendRole } from 'src/enum.js';
import { DownloadService } from 'src/services/download.service.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { ServiceMocks, makeStream, newTestService } from 'test/utils.js';

const downloadResponse: DownloadResponseDto = {
  totalSize: 105_000,
  archives: [
    {
      assetIds: ['asset-1', 'asset-2'],
      size: 105_000,
    },
  ],
};

// assets whose original file has no recorded location yet
const forOriginal = <T extends object>(asset: T) => ({
  ...asset,
  originalBackendId: null,
  originalKey: null,
  originalSize: null,
  originalChecksum: null,
  originalEncryption: null,
});

describe(DownloadService.name, () => {
  let sut: DownloadService;
  let mocks: ServiceMocks;

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  beforeEach(() => {
    ({ sut, mocks } = newTestService(DownloadService));
  });

  describe('downloadArchive', () => {
    it('should skip asset ids that could not be found', async () => {
      const archiveMock = {
        addFile: vitest.fn(),
        addStream: vitest.fn(),
        finalize: vitest.fn(),
        stream: new Readable(),
      };
      const asset = AssetFactory.create();

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id, 'unknown-asset']));
      mocks.asset.getForOriginals.mockResolvedValue([forOriginal(asset)]);
      mocks.storage.createZipStream.mockReturnValue(archiveMock);

      await expect(sut.downloadArchive(authStub.admin, { assetIds: [asset.id, 'unknown-asset'] })).resolves.toEqual({
        stream: archiveMock.stream,
      });

      expect(archiveMock.addFile).toHaveBeenCalledTimes(1);
      expect(archiveMock.addFile).toHaveBeenNthCalledWith(1, asset.originalPath, asset.originalFileName);
    });

    it('should name the files by the storage template on storage backends, where files have no paths', async () => {
      const archiveMock = {
        addFile: vitest.fn(),
        addStream: vitest.fn(),
        finalize: vitest.fn(),
        stream: new Readable(),
      };
      const [asset1, asset2] = [AssetFactory.create(), AssetFactory.create()];
      mocks.storageBackend.configure([
        {
          id: 'originals',
          driver: StorageBackendDriver.Local,
          role: StorageBackendRole.Originals,
          root: '/o',
          encrypted: false,
        },
      ]);
      mocks.systemMetadata.get.mockResolvedValue({
        storageTemplate: { enabled: true, template: '{{y}}/{{#if album}}{{album}}{{else}}Other{{/if}}/{{filename}}' },
      });
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset1.id, asset2.id]));
      mocks.asset.getForOriginals.mockResolvedValue([forOriginal(asset1), forOriginal(asset2)]);
      mocks.asset.getForTemplateNames.mockResolvedValue([
        {
          id: asset1.id,
          type: 'IMAGE',
          fileCreatedAt: new Date('2021-07-04T12:00:00Z'),
          originalFileName: 'IMG_1.JPG',
          make: null,
          model: null,
          lensModel: null,
          albumName: 'Summer',
        },
        {
          id: asset2.id,
          type: 'IMAGE',
          fileCreatedAt: new Date('2022-01-02T12:00:00Z'),
          originalFileName: 'IMG_2.jpg',
          make: null,
          model: null,
          lensModel: null,
          albumName: null,
        },
      ] as never);
      mocks.storage.createZipStream.mockReturnValue(archiveMock);
      mocks.storage.realpath.mockImplementation((path) => Promise.resolve(path));

      await sut.downloadArchive(authStub.admin, { assetIds: [asset1.id, asset2.id] });

      expect(archiveMock.addFile).toHaveBeenNthCalledWith(1, asset1.originalPath, '2021/Summer/IMG_1.jpg');
      expect(archiveMock.addFile).toHaveBeenNthCalledWith(2, asset2.originalPath, '2022/Other/IMG_2.jpg');
    });

    it('should keep the file names without storage backends, where the template already named the files', async () => {
      const archiveMock = {
        addFile: vitest.fn(),
        addStream: vitest.fn(),
        finalize: vitest.fn(),
        stream: new Readable(),
      };
      const asset = AssetFactory.create();
      mocks.systemMetadata.get.mockResolvedValue({
        storageTemplate: { enabled: true, template: '{{y}}/{{filename}}' },
      });
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForOriginals.mockResolvedValue([forOriginal(asset)]);
      mocks.storage.createZipStream.mockReturnValue(archiveMock);
      mocks.storage.realpath.mockImplementation((path) => Promise.resolve(path));

      await sut.downloadArchive(authStub.admin, { assetIds: [asset.id] });

      expect(archiveMock.addFile).toHaveBeenCalledWith(asset.originalPath, asset.originalFileName);
      expect(mocks.asset.getForTemplateNames).not.toHaveBeenCalled();
    });

    it('should log a warning if the original path could not be resolved', async () => {
      const archiveMock = {
        addFile: vitest.fn(),
        addStream: vitest.fn(),
        finalize: vitest.fn(),
        stream: new Readable(),
      };

      const asset1 = AssetFactory.create();
      const asset2 = AssetFactory.create();

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset1.id, asset2.id]));
      mocks.storage.realpath.mockRejectedValue(new Error('Could not read file'));
      mocks.asset.getForOriginals.mockResolvedValue([forOriginal(asset1), forOriginal(asset2)]);
      mocks.storage.createZipStream.mockReturnValue(archiveMock);

      await expect(sut.downloadArchive(authStub.admin, { assetIds: [asset1.id, asset2.id] })).resolves.toEqual({
        stream: archiveMock.stream,
      });

      expect(mocks.logger.warn).toHaveBeenCalledTimes(2);
      expect(archiveMock.addFile).toHaveBeenCalledTimes(2);
      expect(archiveMock.addFile).toHaveBeenNthCalledWith(1, asset1.originalPath, asset1.originalFileName);
      expect(archiveMock.addFile).toHaveBeenNthCalledWith(2, asset2.originalPath, asset2.originalFileName);
    });

    it('should download an archive', async () => {
      const archiveMock = {
        addFile: vitest.fn(),
        addStream: vitest.fn(),
        finalize: vitest.fn(),
        stream: new Readable(),
      };

      const asset1 = AssetFactory.create();
      const asset2 = AssetFactory.create();

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset1.id, asset2.id]));
      mocks.asset.getForOriginals.mockResolvedValue([forOriginal(asset1), forOriginal(asset2)]);
      mocks.storage.createZipStream.mockReturnValue(archiveMock);

      await expect(sut.downloadArchive(authStub.admin, { assetIds: [asset1.id, asset2.id] })).resolves.toEqual({
        stream: archiveMock.stream,
      });

      expect(archiveMock.addFile).toHaveBeenCalledTimes(2);
      expect(archiveMock.addFile).toHaveBeenNthCalledWith(1, asset1.originalPath, asset1.originalFileName);
      expect(archiveMock.addFile).toHaveBeenNthCalledWith(2, asset2.originalPath, asset2.originalFileName);
    });

    it('should handle duplicate file names', async () => {
      const archiveMock = {
        addFile: vitest.fn(),
        addStream: vitest.fn(),
        finalize: vitest.fn(),
        stream: new Readable(),
      };
      const asset1 = AssetFactory.create({ originalFileName: 'IMG_123.jpg' });
      const asset2 = AssetFactory.create({ originalFileName: 'IMG_123.jpg' });

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset1.id, asset2.id]));
      mocks.asset.getForOriginals.mockResolvedValue([forOriginal(asset1), forOriginal(asset2)]);
      mocks.storage.createZipStream.mockReturnValue(archiveMock);

      await expect(sut.downloadArchive(authStub.admin, { assetIds: [asset1.id, asset2.id] })).resolves.toEqual({
        stream: archiveMock.stream,
      });

      expect(archiveMock.addFile).toHaveBeenCalledTimes(2);
      expect(archiveMock.addFile).toHaveBeenNthCalledWith(1, '/data/library/IMG_123.jpg', 'IMG_123.jpg');
      expect(archiveMock.addFile).toHaveBeenNthCalledWith(2, '/data/library/IMG_123.jpg', 'IMG_123+1.jpg');
    });

    it('should be deterministic', async () => {
      const archiveMock = {
        addFile: vitest.fn(),
        addStream: vitest.fn(),
        finalize: vitest.fn(),
        stream: new Readable(),
      };
      const asset1 = AssetFactory.create({ originalFileName: 'IMG_123.jpg' });
      const asset2 = AssetFactory.create({ originalFileName: 'IMG_123.jpg' });

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset1.id, asset2.id]));
      mocks.asset.getForOriginals.mockResolvedValue([forOriginal(asset1), forOriginal(asset2)]);
      mocks.storage.createZipStream.mockReturnValue(archiveMock);

      await expect(sut.downloadArchive(authStub.admin, { assetIds: [asset1.id, asset2.id] })).resolves.toEqual({
        stream: archiveMock.stream,
      });

      expect(archiveMock.addFile).toHaveBeenCalledTimes(2);
      expect(archiveMock.addFile).toHaveBeenNthCalledWith(1, '/data/library/IMG_123.jpg', 'IMG_123.jpg');
      expect(archiveMock.addFile).toHaveBeenNthCalledWith(2, '/data/library/IMG_123.jpg', 'IMG_123+1.jpg');
    });

    it.each([
      { input: '../../../../tmp/pwn.jpg', expected: '........tmppwn.jpg' },
      { input: String.raw`C:\temp\abs3.jpg`, expected: 'Ctempabs3.jpg' },
      { input: 'a/../../b.jpg', expected: 'a....b.jpg' },
      { input: String.raw`..\..\win1.jpg`, expected: '....win1.jpg' },
      { input: '/etc/passwd', expected: 'etcpasswd' },
      { input: '..', expected: 'unnamed' },
      { input: '', expected: 'unnamed' },
    ])('should sanitize unsafe originalFileName "$input" to "$expected"', async ({ input, expected }) => {
      const archiveMock = {
        addFile: vitest.fn(),
        addStream: vitest.fn(),
        finalize: vitest.fn(),
        stream: new Readable(),
      };
      const asset = AssetFactory.create({ originalFileName: input, originalPath: '/data/library/safe.jpg' });

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForOriginals.mockResolvedValue([forOriginal(asset)]);
      mocks.storage.createZipStream.mockReturnValue(archiveMock);

      await expect(sut.downloadArchive(authStub.admin, { assetIds: [asset.id] })).resolves.toEqual({
        stream: archiveMock.stream,
      });

      expect(archiveMock.addFile).toHaveBeenCalledWith('/data/library/safe.jpg', expected);
    });

    it('should dedupe sanitized duplicate unsafe filenames', async () => {
      const archiveMock = {
        addFile: vitest.fn(),
        addStream: vitest.fn(),
        finalize: vitest.fn(),
        stream: new Readable(),
      };
      const asset1 = AssetFactory.create({
        originalFileName: '../../../tmp/pwn.jpg',
        originalPath: '/data/library/a.jpg',
      });
      const asset2 = AssetFactory.create({
        originalFileName: '../../../tmp/pwn.jpg',
        originalPath: '/data/library/b.jpg',
      });

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset1.id, asset2.id]));
      mocks.asset.getForOriginals.mockResolvedValue([forOriginal(asset1), forOriginal(asset2)]);
      mocks.storage.createZipStream.mockReturnValue(archiveMock);

      await expect(sut.downloadArchive(authStub.admin, { assetIds: [asset1.id, asset2.id] })).resolves.toEqual({
        stream: archiveMock.stream,
      });

      expect(archiveMock.addFile).toHaveBeenCalledTimes(2);
      expect(archiveMock.addFile).toHaveBeenNthCalledWith(1, '/data/library/a.jpg', '......tmppwn.jpg');
      expect(archiveMock.addFile).toHaveBeenNthCalledWith(2, '/data/library/b.jpg', '......tmppwn+1.jpg');
    });

    it('should add originals and edited files from their recorded location', async () => {
      const archiveMock = {
        addFile: vitest.fn(),
        addStream: vitest.fn(),
        finalize: vitest.fn(),
        stream: new Readable(),
      };
      const asset = AssetFactory.create({ originalPath: '/data/library/IMG_1.jpg', originalFileName: 'IMG_1.jpg' });
      const edited = AssetFactory.create({ originalPath: '/data/library/IMG_2.jpg', originalFileName: 'IMG_2.jpg' });
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id, edited.id]));
      mocks.asset.getForOriginals.mockResolvedValue([
        {
          ...asset,
          originalBackendId: 'media',
          originalKey: 'library/IMG_1.jpg',
          originalSize: null,
          originalChecksum: null,
          originalEncryption: null,
        },
        {
          ...forOriginal(edited),
          editedPath: '/data/thumbs/IMG_2_edited.jpg',
          editedBackendId: 'media',
          editedKey: 'thumbs/IMG_2_edited.jpg',
          editedSize: null,
          editedChecksum: null,
          editedEncryption: null,
        },
      ]);
      mocks.storage.realpath.mockImplementation((path) => Promise.resolve(path));
      mocks.storage.createZipStream.mockReturnValue(archiveMock);

      await sut.downloadArchive(authStub.admin, { assetIds: [asset.id, edited.id], edited: true });

      expect(mocks.storageBackend.resolve).toHaveBeenCalledWith(
        expect.objectContaining({
          path: '/data/library/IMG_1.jpg',
          backendId: 'media',
          key: 'library/IMG_1.jpg',
        }),
      );
      expect(mocks.storageBackend.resolve).toHaveBeenCalledWith(
        expect.objectContaining({
          path: '/data/thumbs/IMG_2_edited.jpg',
          backendId: 'media',
          key: 'thumbs/IMG_2_edited.jpg',
        }),
      );
      expect(archiveMock.addFile).toHaveBeenCalledWith('/data/library/IMG_1.jpg', 'IMG_1.jpg');
      expect(archiveMock.addFile).toHaveBeenCalledWith('/data/thumbs/IMG_2_edited.jpg', 'IMG_2.jpg');
    });

    it('should resolve symlinks', async () => {
      const archiveMock = {
        addFile: vitest.fn(),
        addStream: vitest.fn(),
        finalize: vitest.fn(),
        stream: new Readable(),
      };

      const asset = AssetFactory.create({ originalPath: '/path/to/symlink.jpg' });
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForOriginals.mockResolvedValue([forOriginal(asset)]);
      mocks.storage.realpath.mockResolvedValue('/path/to/realpath.jpg');
      mocks.storage.createZipStream.mockReturnValue(archiveMock);

      await expect(sut.downloadArchive(authStub.admin, { assetIds: [asset.id] })).resolves.toEqual({
        stream: archiveMock.stream,
      });

      expect(archiveMock.addFile).toHaveBeenCalledWith('/path/to/realpath.jpg', asset.originalFileName);
    });
  });

  describe('getDownloadInfo', () => {
    it('should throw an error for an invalid dto', async () => {
      await expect(sut.getDownloadInfo(authStub.admin, {})).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should return a list of archives (assetIds)', async () => {
      const assetIds = ['asset-1', 'asset-2'];

      mocks.user.getMetadata.mockResolvedValue([]);
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(assetIds));
      mocks.downloadRepository.downloadAssetIds.mockReturnValue(
        makeStream([
          { id: 'asset-1', livePhotoVideoId: null, size: 100_000 },
          { id: 'asset-2', livePhotoVideoId: null, size: 5000 },
        ]),
      );

      await expect(sut.getDownloadInfo(authStub.admin, { assetIds })).resolves.toEqual(downloadResponse);

      expect(mocks.downloadRepository.downloadAssetIds).toHaveBeenCalledWith(['asset-1', 'asset-2']);
    });

    it('should return a list of archives (albumId)', async () => {
      mocks.user.getMetadata.mockResolvedValue([]);
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set(['album-1']));
      mocks.downloadRepository.downloadAlbumId.mockReturnValue(
        makeStream([
          { id: 'asset-1', livePhotoVideoId: null, size: 100_000 },
          { id: 'asset-2', livePhotoVideoId: null, size: 5000 },
        ]),
      );

      await expect(sut.getDownloadInfo(authStub.admin, { albumId: 'album-1' })).resolves.toEqual(downloadResponse);

      expect(mocks.access.album.checkOwnerAccess).toHaveBeenCalledWith(authStub.admin.user.id, new Set(['album-1']));
      expect(mocks.downloadRepository.downloadAlbumId).toHaveBeenCalledWith('album-1');
    });

    it('should return a list of archives (userId)', async () => {
      mocks.user.getMetadata.mockResolvedValue([]);
      mocks.downloadRepository.downloadUserId.mockReturnValue(
        makeStream([
          { id: 'asset-1', livePhotoVideoId: null, size: 100_000 },
          { id: 'asset-2', livePhotoVideoId: null, size: 5000 },
        ]),
      );

      await expect(sut.getDownloadInfo(authStub.admin, { userId: authStub.admin.user.id })).resolves.toEqual(
        downloadResponse,
      );

      expect(mocks.downloadRepository.downloadUserId).toHaveBeenCalledWith(authStub.admin.user.id);
    });

    it('should split archives by size', async () => {
      mocks.user.getMetadata.mockResolvedValue([]);
      mocks.downloadRepository.downloadUserId.mockReturnValue(
        makeStream([
          { id: 'asset-1', livePhotoVideoId: null, size: 5000 },
          { id: 'asset-2', livePhotoVideoId: null, size: 100_000 },
          { id: 'asset-3', livePhotoVideoId: null, size: 23_456 },
          { id: 'asset-4', livePhotoVideoId: null, size: 123_000 },
        ]),
      );

      await expect(
        sut.getDownloadInfo(authStub.admin, {
          userId: authStub.admin.user.id,
          archiveSize: 30_000,
        }),
      ).resolves.toEqual({
        totalSize: 251_456,
        archives: [
          { assetIds: ['asset-1', 'asset-2'], size: 105_000 },
          { assetIds: ['asset-3', 'asset-4'], size: 146_456 },
        ],
      });
    });

    it('should include the video portion of a live photo', async () => {
      const assetIds = ['asset-1', 'asset-2'];

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(assetIds));
      mocks.user.getMetadata.mockResolvedValue([]);
      mocks.downloadRepository.downloadAssetIds.mockReturnValue(
        makeStream([
          { id: 'asset-1', livePhotoVideoId: 'asset-3', size: 5000 },
          { id: 'asset-2', livePhotoVideoId: 'asset-4', size: 100_000 },
        ]),
      );
      mocks.downloadRepository.downloadMotionAssetIds.mockReturnValue(
        makeStream([
          { id: 'asset-3', livePhotoVideoId: null, size: 23_456, originalPath: '/path/to/file.mp4' },
          { id: 'asset-4', livePhotoVideoId: null, size: 123_000, originalPath: '/path/to/file.mp4' },
        ]),
      );

      await expect(sut.getDownloadInfo(authStub.admin, { assetIds, archiveSize: 30_000 })).resolves.toEqual({
        totalSize: 251_456,
        archives: [
          { assetIds: ['asset-1', 'asset-2'], size: 105_000 },
          { assetIds: ['asset-3', 'asset-4'], size: 146_456 },
        ],
      });
    });

    it('should skip the video portion of an android live photo by default', async () => {
      const assetIds = ['asset-1'];

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(assetIds));
      mocks.user.getMetadata.mockResolvedValue([]);
      mocks.downloadRepository.downloadAssetIds.mockReturnValue(
        makeStream([{ id: 'asset-1', livePhotoVideoId: 'asset-3', size: 5000 }]),
      );

      mocks.downloadRepository.downloadMotionAssetIds.mockReturnValue(
        makeStream([
          {
            id: 'asset-2',
            livePhotoVideoId: null,
            size: 23_456,
            originalPath: '/data/encoded-video/uuid-MP.mp4',
          },
        ]),
      );

      await expect(sut.getDownloadInfo(authStub.admin, { assetIds })).resolves.toEqual({
        totalSize: 5000,
        archives: [
          {
            assetIds: ['asset-1'],
            size: 5000,
          },
        ],
      });
    });
  });
});
