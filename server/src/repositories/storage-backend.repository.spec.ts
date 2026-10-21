import { Kysely } from 'kysely';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mocked } from 'vitest';
import { StorageCore } from 'src/cores/storage.core.js';
import { StorageBackendDriver, StorageBackendRole } from 'src/enum.js';
import { BlobStore } from 'src/repositories/blob-store.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageBackendRepository } from 'src/repositories/storage-backend.repository.js';
import { DB } from 'src/schema/index.js';

describe(StorageBackendRepository.name, () => {
  let sut: StorageBackendRepository;
  let logger: Mocked<Pick<LoggingRepository, 'setContext' | 'warn'>>;

  beforeEach(() => {
    StorageCore.setMediaLocation('/data');
    logger = { setContext: vi.fn(), warn: vi.fn() };
    sut = new StorageBackendRepository(undefined as unknown as Kysely<DB>, logger as unknown as LoggingRepository);
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

  describe('readConfig', () => {
    let directory: string;

    const write = async (content: string) => {
      const path = join(directory, 'storage.yaml');
      await fs.writeFile(path, content);
      return path;
    };

    beforeEach(async () => {
      directory = await fs.mkdtemp(join(tmpdir(), 'immich-storage-config-'));
    });

    afterEach(async () => {
      await fs.rm(directory, { recursive: true, force: true });
    });

    it('should read a YAML configuration', async () => {
      const path = await write(
        ['backends:', '  - id: originals', '    driver: local', '    role: originals', '    root: /mnt/originals'].join(
          '\n',
        ),
      );

      await expect(sut.readConfig(path)).resolves.toEqual({
        backends: [{ id: 'originals', driver: 'local', role: 'originals', root: '/mnt/originals' }],
      });
    });

    it('should read a JSON configuration', async () => {
      const path = await write(
        JSON.stringify({ backends: [{ id: 'derived-1', driver: 'local', role: 'derived', root: '/mnt/derived' }] }),
      );

      await expect(sut.readConfig(path)).resolves.toEqual({
        backends: [{ id: 'derived-1', driver: 'local', role: 'derived', root: '/mnt/derived' }],
      });
    });

    it('should read a configuration without backends', async () => {
      await expect(sut.readConfig(await write('backends: []'))).resolves.toEqual({ backends: [] });
    });

    it.each([
      ['an empty file', '', 'backends'],
      ['malformed YAML', 'backends: [', 'Invalid storage backend configuration'],
      ['a list instead of an object', '- id: a', '(root)'],
      ['a missing id', '{"backends":[{"driver":"local","role":"originals","root":"/a"}]}', 'backends.0.id'],
      [
        'an id with capitals',
        '{"backends":[{"id":"Originals","driver":"local","role":"originals","root":"/a"}]}',
        'lowercase',
      ],
      ['a reserved id', '{"backends":[{"id":"media","driver":"local","role":"originals","root":"/a"}]}', 'reserved'],
      [
        'an unknown driver',
        '{"backends":[{"id":"a","driver":"ftp","role":"originals","root":"/a"}]}',
        'backends.0.driver',
      ],
      ['an unknown role', '{"backends":[{"id":"a","driver":"local","role":"photos","root":"/a"}]}', 'backends.0.role'],
      ['a relative root', '{"backends":[{"id":"a","driver":"local","role":"originals","root":"a"}]}', 'absolute path'],
      ['an unknown option', '{"backends":[{"id":"a","driver":"local","role":"originals","root":"/a","x":1}]}', 'x'],
      [
        'a duplicate id',
        '{"backends":[{"id":"a","driver":"local","role":"originals","root":"/a"},{"id":"a","driver":"local","role":"derived","root":"/b"}]}',
        'Duplicate id a',
      ],
      [
        'two backends with the same role',
        '{"backends":[{"id":"a","driver":"local","role":"originals","root":"/a"},{"id":"b","driver":"local","role":"originals","root":"/b"}]}',
        'Only one storage backend can have the role originals',
      ],
    ])('should reject %s', async (_, content, message) => {
      const path = await write(content);
      await expect(sut.readConfig(path)).rejects.toThrow(`Invalid storage backend configuration in ${path}`);
      await expect(sut.readConfig(path)).rejects.toThrow(message);
    });

    it('should fail for a missing file', async () => {
      await expect(sut.readConfig(join(directory, 'missing.yaml'))).rejects.toThrow('ENOENT');
    });
  });

  describe('configure', () => {
    it('should make configured local backends available', () => {
      sut.configure([
        { id: 'originals', driver: StorageBackendDriver.Local, role: StorageBackendRole.Originals, root: '/mnt/o' },
      ]);

      expect(sut.get('originals').getLocalPath?.('a/b.jpg')).toBe('/mnt/o/a/b.jpg');
      expect(sut.get('media').getLocalPath?.('a.jpg')).toBe('/data/a.jpg');
    });

    it('should replace the backends configured before', () => {
      sut.configure([
        { id: 'originals', driver: StorageBackendDriver.Local, role: StorageBackendRole.Originals, root: '/mnt/o' },
      ]);
      sut.configure([]);

      expect(() => sut.get('originals')).toThrow('Unknown storage backend: originals');
    });

    it('should resolve files on a configured backend without comparing them to their path', () => {
      sut.configure([
        { id: 'originals', driver: StorageBackendDriver.Local, role: StorageBackendRole.Originals, root: '/mnt/o' },
      ]);

      // the path of a file on a configured backend is not where it is stored
      expect(sut.getLocalPath({ path: '/data/upload/a.jpg', backendId: 'originals', key: 'f1/a1' })).toBe(
        '/mnt/o/f1/a1',
      );
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });
});
