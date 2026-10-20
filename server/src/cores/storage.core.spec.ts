import { vitest } from 'vitest';
import { StorageCore } from 'src/cores/storage.core.js';

vitest.mock('src/constants', () => ({
  IWorker: 'IWorker',
}));

describe('StorageCore', () => {
  describe('isImmichPath', () => {
    beforeAll(() => {
      StorageCore.setMediaLocation('/photos');
    });

    it('should return true for APP_MEDIA_LOCATION path', () => {
      const immichPath = '/photos';
      expect(StorageCore.isImmichPath(immichPath)).toBe(true);
    });

    it('should return true for paths within the APP_MEDIA_LOCATION', () => {
      const immichPath = '/photos/new/';
      expect(StorageCore.isImmichPath(immichPath)).toBe(true);
    });

    it('should return false for paths outside the APP_MEDIA_LOCATION and same starts', () => {
      const nonImmichPath = '/photos_new';
      expect(StorageCore.isImmichPath(nonImmichPath)).toBe(false);
    });

    it('should return false for paths outside the APP_MEDIA_LOCATION', () => {
      const nonImmichPath = '/some/other/path';
      expect(StorageCore.isImmichPath(nonImmichPath)).toBe(false);
    });
  });

  describe('getStorageLocation', () => {
    beforeAll(() => {
      StorageCore.setMediaLocation('/photos');
    });

    it('should use the media backend with a relative key for files under the media location', () => {
      expect(StorageCore.getStorageLocation('/photos/thumbs/user-id/ab/cd/asset_thumbnail.webp')).toEqual({
        backendId: 'media',
        key: 'thumbs/user-id/ab/cd/asset_thumbnail.webp',
      });
    });

    it('should normalize the path before computing the key', () => {
      expect(StorageCore.getStorageLocation('/photos/upload//user-id/./ab/file.jpg')).toEqual({
        backendId: 'media',
        key: 'upload/user-id/ab/file.jpg',
      });
    });

    it('should keep unusual file names', () => {
      expect(StorageCore.getStorageLocation('/photos/library/admin/2024/IMG 1234 (1).HEIC')).toEqual({
        backendId: 'media',
        key: 'library/admin/2024/IMG 1234 (1).HEIC',
      });
    });

    it('should use the media backend for a name that starts with two dots', () => {
      expect(StorageCore.getStorageLocation('/photos/..hidden')).toEqual({ backendId: 'media', key: '..hidden' });
    });

    it('should use the host backend for files outside the media location', () => {
      expect(StorageCore.getStorageLocation('/mnt/external/2024/IMG_1.jpg.xmp')).toEqual({
        backendId: 'host',
        key: 'mnt/external/2024/IMG_1.jpg.xmp',
      });
    });

    it('should use the host backend for a sibling folder with the same prefix', () => {
      expect(StorageCore.getStorageLocation('/photos_new/file.jpg')).toEqual({
        backendId: 'host',
        key: 'photos_new/file.jpg',
      });
    });

    it('should use the host backend for a path that leaves the media location', () => {
      expect(StorageCore.getStorageLocation('/photos/../etc/file.jpg')).toEqual({
        backendId: 'host',
        key: 'etc/file.jpg',
      });
    });

    it('should use the host backend for the media location itself, which is a folder rather than a file', () => {
      expect(StorageCore.getStorageLocation('/photos')).toEqual({ backendId: 'host', key: 'photos' });
    });

    it('should reject the filesystem root', () => {
      expect(() => StorageCore.getStorageLocation('/')).toThrow('Invalid blob key');
    });

    it('should reject a relative path', () => {
      expect(() => StorageCore.getStorageLocation('photos/file.jpg')).toThrow('Expected an absolute path');
    });
  });
});
