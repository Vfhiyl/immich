import { JobName, JobStatus, SystemMetadataKey } from 'src/enum.js';
import { StorageService } from 'src/services/storage.service.js';
import { ImmichStartupError } from 'src/utils/misc.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const file = (id: string, path: string) => ({ id, path });

describe(StorageService.name, () => {
  let sut: StorageService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(StorageService));
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('onBootstrap', () => {
    it('should enable mount folder checking', async () => {
      mocks.systemMetadata.get.mockResolvedValue(null);
      mocks.asset.getFileSamples.mockResolvedValue([]);
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({
          storage: {
            ignoreMountCheckErrors: false,
            mediaLocation: '/data',
          },
        }),
      );

      await expect(sut.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.SystemFlags, {
        mountChecks: {
          backups: true,
          'encoded-video': true,
          library: true,
          profile: true,
          thumbs: true,
          upload: true,
        },
      });
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/encoded-video'));
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/library'));
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/profile'));
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/thumbs'));
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/upload'));
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/backups'));
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/encoded-video/.immich'),
        expect.any(Buffer),
      );
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/library/.immich'),
        expect.any(Buffer),
      );
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/profile/.immich'),
        expect.any(Buffer),
      );
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/thumbs/.immich'),
        expect.any(Buffer),
      );
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/upload/.immich'),
        expect.any(Buffer),
      );
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/backups/.immich'),
        expect.any(Buffer),
      );
    });

    it('should enable mount folder checking for a new folder type', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        mountChecks: {
          backups: false,
          'encoded-video': true,
          library: false,
          profile: true,
          thumbs: true,
          upload: true,
        },
      });
      mocks.asset.getFileSamples.mockResolvedValue([]);
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({
          storage: {
            ignoreMountCheckErrors: false,
            mediaLocation: '/data',
          },
        }),
      );

      await expect(sut.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.SystemFlags, {
        mountChecks: {
          backups: true,
          'encoded-video': true,
          library: true,
          profile: true,
          thumbs: true,
          upload: true,
        },
      });
      expect(mocks.storage.mkdirSync).toHaveBeenCalledTimes(2);
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/library'));
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/backups'));
      expect(mocks.storage.createFile).toHaveBeenCalledTimes(2);
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/library/.immich'),
        expect.any(Buffer),
      );
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/backups/.immich'),
        expect.any(Buffer),
      );
    });

    it('should throw an error if .immich is missing', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ mountChecks: { upload: true } });
      mocks.storage.readFile.mockRejectedValue(new Error("ENOENT: no such file or directory, open '/app/.immich'"));

      await expect(sut.onBootstrap()).rejects.toThrow('Failed to read');

      expect(mocks.storage.createOrOverwriteFile).not.toHaveBeenCalled();
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('should throw an error if .immich is present but read-only', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ mountChecks: { upload: true } });
      mocks.storage.overwriteFile.mockRejectedValue(
        new Error("ENOENT: no such file or directory, open '/app/.immich'"),
      );

      await expect(sut.onBootstrap()).rejects.toThrow('Failed to write');

      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('should skip mount file creation if file already exists', async () => {
      const error = new Error('Error creating file') as any;
      error.code = 'EEXIST';
      mocks.systemMetadata.get.mockResolvedValue({ mountChecks: {} });
      mocks.storage.createFile.mockRejectedValue(error);
      mocks.asset.getFileSamples.mockResolvedValue([]);

      await expect(sut.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.logger.warn).toHaveBeenCalledWith('Found existing mount file, skipping creation');
    });

    it('should throw an error if mount file could not be created', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ mountChecks: {} });
      mocks.storage.createFile.mockRejectedValue(new Error('Error creating file'));

      await expect(sut.onBootstrap()).rejects.toBeInstanceOf(ImmichStartupError);
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('should startup if checks are disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ mountChecks: { upload: true } });
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({
          storage: { ignoreMountCheckErrors: true },
        }),
      );
      mocks.asset.getFileSamples.mockResolvedValue([]);
      mocks.storage.overwriteFile.mockRejectedValue(
        new Error("ENOENT: no such file or directory, open '/app/.immich'"),
      );

      await expect(sut.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.systemMetadata.set).not.toHaveBeenCalledWith(SystemMetadataKey.SystemFlags, expect.anything());
    });
  });

  describe('handleDeleteFiles', () => {
    it('should handle null values', async () => {
      await sut.handleDeleteFiles({ files: [undefined, null] });

      expect(mocks.storage.unlink).not.toHaveBeenCalled();
    });

    it('should handle an error removing a file', async () => {
      mocks.storage.unlink.mockRejectedValue(new Error('something-went-wrong'));

      await sut.handleDeleteFiles({ files: ['path/to/something'] });

      expect(mocks.storage.unlink).toHaveBeenCalledWith('path/to/something');
    });

    it('should remove the file', async () => {
      await sut.handleDeleteFiles({ files: ['path/to/something'] });

      expect(mocks.storage.unlink).toHaveBeenCalledWith('path/to/something');
    });
  });

  describe('onBootstrapFileLocations', () => {
    it('should queue the backfill when some files have no storage location', async () => {
      mocks.asset.hasFilesWithoutLocation.mockResolvedValue(true);

      await sut.onBootstrapFileLocations();

      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.AssetFileLocationBackfill });
    });

    it('should not queue the backfill when every file has a storage location', async () => {
      mocks.asset.hasFilesWithoutLocation.mockResolvedValue(false);

      await sut.onBootstrapFileLocations();

      expect(mocks.job.queue).not.toHaveBeenCalled();
    });
  });

  describe('handleAssetFileLocationBackfill', () => {
    // the storage repository mock sets the media location to /data
    it('should use the media backend for files under the media location and the host backend otherwise', async () => {
      mocks.asset.getFilesWithoutLocation.mockResolvedValueOnce([
        file('file-1', '/data/thumbs/user-id/ab/cd/asset_thumbnail.webp'),
        file('file-2', '/mnt/external/IMG_1.jpg.xmp'),
      ]);
      mocks.asset.setFileLocations.mockResolvedValue(2);

      await expect(sut.handleAssetFileLocationBackfill()).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.getFilesWithoutLocation).toHaveBeenCalledTimes(1);
      expect(mocks.asset.getFilesWithoutLocation).toHaveBeenCalledWith({ afterId: undefined, limit: 5000 });
      expect(mocks.asset.setFileLocations).toHaveBeenCalledWith([
        { id: 'file-1', backendId: 'media', key: 'thumbs/user-id/ab/cd/asset_thumbnail.webp' },
        { id: 'file-2', backendId: 'host', key: 'mnt/external/IMG_1.jpg.xmp' },
      ]);
      expect(mocks.logger.warn).not.toHaveBeenCalled();
    });

    it('should do nothing when there are no files without a location', async () => {
      await expect(sut.handleAssetFileLocationBackfill()).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.setFileLocations).not.toHaveBeenCalled();
    });

    it('should continue after the last file of a full batch until no files are left', async () => {
      const firstBatch = Array.from({ length: 5000 }, (_, index) => file(`file-${index}`, `/data/upload/${index}.jpg`));
      mocks.asset.getFilesWithoutLocation
        .mockResolvedValueOnce(firstBatch)
        .mockResolvedValueOnce([file('file-last', '/data/upload/last.jpg')]);
      mocks.asset.setFileLocations.mockResolvedValueOnce(5000).mockResolvedValueOnce(1);

      await expect(sut.handleAssetFileLocationBackfill()).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.getFilesWithoutLocation).toHaveBeenCalledTimes(2);
      expect(mocks.asset.getFilesWithoutLocation).toHaveBeenNthCalledWith(2, { afterId: 'file-4999', limit: 5000 });
      expect(mocks.asset.setFileLocations).toHaveBeenNthCalledWith(2, [
        { id: 'file-last', backendId: 'media', key: 'upload/last.jpg' },
      ]);
    });

    it('should page past files it skipped so they are not read again', async () => {
      mocks.asset.getFilesWithoutLocation
        .mockResolvedValueOnce(Array.from({ length: 5000 }, (_, index) => file(`file-${index}`, 'relative/path.jpg')))
        .mockResolvedValueOnce([]);

      await expect(sut.handleAssetFileLocationBackfill()).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.getFilesWithoutLocation).toHaveBeenNthCalledWith(2, { afterId: 'file-4999', limit: 5000 });
      expect(mocks.asset.setFileLocations).toHaveBeenCalledWith([]);
    });

    it('should skip a file whose path cannot be mapped to a storage location', async () => {
      mocks.asset.getFilesWithoutLocation.mockResolvedValueOnce([
        file('file-1', 'relative/path.jpg'),
        file('file-2', '/data/upload/file.jpg'),
      ]);
      mocks.asset.setFileLocations.mockResolvedValue(1);

      await expect(sut.handleAssetFileLocationBackfill()).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.setFileLocations).toHaveBeenCalledWith([
        { id: 'file-2', backendId: 'media', key: 'upload/file.jpg' },
      ]);
      expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('file-1'));
      expect(mocks.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Skipped 1 asset file(s) with an unusable path'),
      );
    });

    it('should only give a location shared by several files in a batch to the first of them', async () => {
      mocks.asset.getFilesWithoutLocation.mockResolvedValueOnce([
        file('file-1', '/data/upload/same.jpg'),
        file('file-2', '/data/upload/same.jpg'),
      ]);
      mocks.asset.setFileLocations.mockResolvedValue(1);

      await expect(sut.handleAssetFileLocationBackfill()).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.setFileLocations).toHaveBeenCalledWith([
        { id: 'file-1', backendId: 'media', key: 'upload/same.jpg' },
      ]);
      expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('1 asset file(s) whose path is shared'));
    });

    it('should give a host location shared by several files to all of them', async () => {
      mocks.asset.getFilesWithoutLocation.mockResolvedValueOnce([
        file('file-1', '/mnt/external/IMG_1.jpg.xmp'),
        file('file-2', '/mnt/external/IMG_1.jpg.xmp'),
      ]);
      mocks.asset.setFileLocations.mockResolvedValue(2);

      await expect(sut.handleAssetFileLocationBackfill()).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.setFileLocations).toHaveBeenCalledWith([
        { id: 'file-1', backendId: 'host', key: 'mnt/external/IMG_1.jpg.xmp' },
        { id: 'file-2', backendId: 'host', key: 'mnt/external/IMG_1.jpg.xmp' },
      ]);
      expect(mocks.logger.warn).not.toHaveBeenCalled();
    });

    it('should count files whose location already belongs to another file as shared', async () => {
      mocks.asset.getFilesWithoutLocation.mockResolvedValueOnce([
        file('file-1', '/data/upload/a.jpg'),
        file('file-2', '/data/upload/b.jpg'),
      ]);
      mocks.asset.setFileLocations.mockResolvedValue(1);

      await expect(sut.handleAssetFileLocationBackfill()).resolves.toBe(JobStatus.Success);

      expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('1 asset file(s) whose path is shared'));
    });
  });
});
