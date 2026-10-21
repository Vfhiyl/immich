import { Mocked } from 'vitest';
import { StorageCore } from 'src/cores/storage.core.js';
import { BlobStore } from 'src/repositories/blob-store.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageBackendRepository } from 'src/repositories/storage-backend.repository.js';

describe(StorageBackendRepository.name, () => {
  let sut: StorageBackendRepository;
  let logger: Mocked<Pick<LoggingRepository, 'setContext' | 'warn'>>;

  beforeEach(() => {
    StorageCore.setMediaLocation('/data');
    logger = { setContext: vi.fn(), warn: vi.fn() };
    sut = new StorageBackendRepository(logger as unknown as LoggingRepository);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('get', () => {
    it('should keep media files below the media location', () => {
      expect(sut.get('media').getLocalPath?.('thumbs/user/a.webp')).toBe('/data/thumbs/user/a.webp');
    });

    it('should follow a change of the media location', () => {
      const before = sut.get('media');
      expect(sut.get('media')).toBe(before);

      StorageCore.setMediaLocation('/photos');

      expect(sut.get('media')).not.toBe(before);
      expect(sut.get('media').getLocalPath?.('thumbs/user/a.webp')).toBe('/photos/thumbs/user/a.webp');
    });

    it('should keep host files at their absolute path', () => {
      expect(sut.get('host').getLocalPath?.('mnt/photos/IMG_1.jpg')).toBe('/mnt/photos/IMG_1.jpg');
    });

    it('should reject an unknown backend', () => {
      expect(() => sut.get('unknown')).toThrow('Unknown storage backend: unknown');
    });
  });

  describe('getLocalPath', () => {
    it('should use the path of a file without a recorded location', () => {
      expect(sut.getLocalPath({ path: '/data/upload/a.jpg', backendId: null, key: null })).toBe('/data/upload/a.jpg');
    });

    it('should use the recorded location of a media file', () => {
      expect(sut.getLocalPath({ path: '/data/upload/a.jpg', backendId: 'media', key: 'upload/a.jpg' })).toBe(
        '/data/upload/a.jpg',
      );
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('should use the recorded location of a host file', () => {
      expect(sut.getLocalPath({ path: '/mnt/a.jpg.xmp', backendId: 'host', key: 'mnt/a.jpg.xmp' })).toBe(
        '/mnt/a.jpg.xmp',
      );
    });

    it('should treat paths that only differ in normalization as the same file', () => {
      expect(sut.getLocalPath({ path: '/data//upload/./a.jpg', backendId: 'media', key: 'upload/a.jpg' })).toBe(
        '/data/upload/a.jpg',
      );
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('should use the path and warn when the location of a local file names another file', () => {
      expect(sut.getLocalPath({ path: '/data/library/a.jpg', backendId: 'media', key: 'upload/a.jpg' })).toBe(
        '/data/library/a.jpg',
      );
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('media:upload/a.jpg does not match'));
    });

    it('should fail for a backend that does not keep files on the local filesystem', () => {
      const remote = { limits: {} } as BlobStore;
      vi.spyOn(sut, 'get').mockReturnValue(remote);

      expect(() => sut.getLocalPath({ path: '/data/a.jpg', backendId: 'remote', key: 'a' })).toThrow(
        'Storage backend remote does not keep files on the local filesystem',
      );
    });
  });

  describe('lease', () => {
    it('should lend a file on a local backend where it is', async () => {
      await using lease = await sut.lease({ path: '/data/upload/a.jpg', backendId: 'media', key: 'upload/a.jpg' });

      expect(lease.path).toBe('/data/upload/a.jpg');
    });

    it('should lend a file without a recorded location by its path', async () => {
      const lease = await sut.lease({ path: '/mnt/a.jpg', backendId: null, key: null });

      expect(lease.path).toBe('/mnt/a.jpg');
      await expect(lease[Symbol.asyncDispose]()).resolves.toBeUndefined();
    });
  });
});
