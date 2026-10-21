import { Kysely } from 'kysely';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Mocked } from 'vitest';
import { StorageCore } from 'src/cores/storage.core.js';
import { StorageBackendDriver, StorageBackendRole } from 'src/enum.js';
import { BlobNotFoundError, BlobStore } from 'src/repositories/blob-store.js';
import { openTrailer } from 'src/repositories/encrypted-blob-store.js';
import { MasterKeys } from 'src/repositories/key-provider.js';
import { LocalBlobStore } from 'src/repositories/local-blob-store.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { S3BlobStore } from 'src/repositories/s3-blob-store.js';
import { StorageBackendRepository, toFileDeletion } from 'src/repositories/storage-backend.repository.js';
import { DB } from 'src/schema/index.js';

const s3 = (overrides: Record<string, unknown>) =>
  JSON.stringify({
    backends: [
      {
        id: 'originals',
        driver: 's3',
        role: 'originals',
        endpoint: 'https://storage.example.com',
        region: 'region-1',
        bucket: 'photos',
        credentials: { type: 'chain' },
        encrypted: false,
        ...overrides,
      },
    ],
  });

describe(StorageBackendRepository.name, () => {
  let sut: StorageBackendRepository;
  let logger: Mocked<Pick<LoggingRepository, 'setContext' | 'warn' | 'debug'>>;

  beforeEach(() => {
    StorageCore.setMediaLocation('/data');
    logger = { setContext: vi.fn(), warn: vi.fn(), debug: vi.fn() };
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
        backends: [{ id: 'originals', driver: 'local', role: 'originals', root: '/mnt/originals', encrypted: false }],
      });
    });

    it('should read a JSON configuration', async () => {
      const path = await write(
        JSON.stringify({ backends: [{ id: 'derived-1', driver: 'local', role: 'derived', root: '/mnt/derived' }] }),
      );

      await expect(sut.readConfig(path)).resolves.toEqual({
        backends: [{ id: 'derived-1', driver: 'local', role: 'derived', root: '/mnt/derived', encrypted: false }],
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

    it('should read an S3 backend with defaults for the prefix, addressing and encryption', async () => {
      const path = await write(
        [
          'encryption:',
          '  masterKeyFile: /run/secrets/master.key',
          'backends:',
          '  - id: originals',
          '    driver: s3',
          '    role: originals',
          '    endpoint: https://storage.example.com',
          '    region: region-1',
          '    bucket: photos',
          '    credentials:',
          '      type: static',
          '      accessKeyId: AKID',
          '      secretAccessKeyFile: /run/secrets/s3',
        ].join('\n'),
      );

      await expect(sut.readConfig(path)).resolves.toEqual({
        backends: [
          {
            id: 'originals',
            driver: 's3',
            role: 'originals',
            endpoint: 'https://storage.example.com',
            region: 'region-1',
            bucket: 'photos',
            prefix: '',
            addressing: 'virtual-host',
            credentials: { type: 'static', accessKeyId: 'AKID', secretAccessKeyFile: '/run/secrets/s3' },
            encrypted: true,
          },
        ],
        encryption: { masterKeyFile: '/run/secrets/master.key' },
      });
    });

    it('should need a master key file for an encrypted backend', async () => {
      const unencrypted = JSON.parse(s3({ encrypted: undefined }));
      const path = await write(JSON.stringify(unencrypted));
      await expect(sut.readConfig(path)).rejects.toThrow(
        'backends.0.encrypted: An encrypted storage backend needs a master key file (encryption.masterKeyFile)',
      );

      const local = '{"backends":[{"id":"a","driver":"local","role":"originals","root":"/a","encrypted":true}]}';
      await expect(sut.readConfig(await write(local))).rejects.toThrow('needs a master key file');
    });

    it('should read an S3 backend that is not encrypted without a master key file', async () => {
      const { backends } = await sut.readConfig(await write(s3({ encrypted: false })));
      expect(backends[0]).toMatchObject({ encrypted: false });
    });

    it.each([
      ['a relative master key file', { masterKeyFile: 'master.key' }, 'absolute path'],
      ['an unknown encryption option', { masterKeyFile: '/m', algorithm: 'aes' }, 'algorithm'],
    ])('should reject %s', async (_, encryption, message) => {
      const path = await write(JSON.stringify({ ...JSON.parse(s3({})), encryption }));
      await expect(sut.readConfig(path)).rejects.toThrow(message);
    });

    it.each([
      ['an endpoint that is not http(s)', { endpoint: 'ftp://storage.example.com' }, 'endpoint'],
      ['a prefix without a trailing slash', { prefix: 'immich' }, 'prefix'],
      ['a prefix with an empty segment', { prefix: 'immich//' }, 'prefix'],
      ['an unknown addressing', { addressing: 'dns' }, 'addressing'],
      ['missing credentials', { credentials: undefined }, 'credentials'],
      [
        'a secret in the configuration',
        { credentials: { type: 'static', accessKeyId: 'a', secretAccessKey: 'b' } },
        'secretAccessKey',
      ],
    ])('should reject an S3 backend with %s', async (_, overrides, message) => {
      const path = await write(s3(overrides));
      await expect(sut.readConfig(path)).rejects.toThrow(message);
    });

    it('should fail for a missing file', async () => {
      await expect(sut.readConfig(join(directory, 'missing.yaml'))).rejects.toThrow('ENOENT');
    });
  });

  describe('configure', () => {
    it('should make configured local backends available', () => {
      sut.configure([
        {
          id: 'originals',
          driver: StorageBackendDriver.Local,
          role: StorageBackendRole.Originals,
          root: '/mnt/o',
          encrypted: false,
        },
      ]);

      expect(sut.get('originals').getLocalPath?.('a/b.jpg')).toBe('/mnt/o/a/b.jpg');
      expect(sut.get('media').getLocalPath?.('a.jpg')).toBe('/data/a.jpg');
    });

    it('should make configured S3 backends available, which do not keep files locally', () => {
      sut.configure([
        {
          id: 'remote',
          driver: StorageBackendDriver.S3,
          role: StorageBackendRole.Originals,
          endpoint: 'https://storage.example.com',
          region: 'region-1',
          bucket: 'photos',
          prefix: '',
          addressing: 'path',
          credentials: { type: 'chain' },
          encrypted: false,
        },
      ]);

      expect(sut.get('remote')).toBeInstanceOf(S3BlobStore);
      expect(() => sut.getLocalPath({ path: '/data/a.jpg', backendId: 'remote', key: 'k' })).toThrow(
        'Storage backend remote does not keep files on the local filesystem',
      );
    });

    it('should replace the backends configured before', () => {
      sut.configure([
        {
          id: 'originals',
          driver: StorageBackendDriver.Local,
          role: StorageBackendRole.Originals,
          root: '/mnt/o',
          encrypted: false,
        },
      ]);
      sut.configure([]);

      expect(() => sut.get('originals')).toThrow('Unknown storage backend: originals');
    });

    it('should resolve files on a configured backend without comparing them to their path', () => {
      sut.configure([
        {
          id: 'originals',
          driver: StorageBackendDriver.Local,
          role: StorageBackendRole.Originals,
          root: '/mnt/o',
          encrypted: false,
        },
      ]);

      // the path of a file on a configured backend is not where it is stored
      expect(sut.getLocalPath({ path: '/data/upload/a.jpg', backendId: 'originals', key: 'f1/a1' })).toBe(
        '/mnt/o/f1/a1',
      );
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('createOutput', () => {
    let directory: string;

    beforeEach(async () => {
      directory = await fs.mkdtemp(join(tmpdir(), 'immich-output-'));
      StorageCore.setMediaLocation(join(directory, 'media'));
    });

    afterEach(async () => {
      await fs.rm(directory, { recursive: true, force: true });
    });

    const configureDerived = () =>
      sut.configure([
        {
          id: 'derived',
          driver: StorageBackendDriver.Local,
          role: StorageBackendRole.Derived,
          root: join(directory, 'derived'),
          encrypted: false,
        },
      ]);

    it('should write to the path itself when no backend is configured for the role', async () => {
      const path = join(directory, 'media', 'thumbs', 'a_preview.jpeg');
      await using output = await sut.createOutput(StorageBackendRole.Derived, path);

      expect(output.path).toBe(path);
      await expect(output.commit()).resolves.toEqual({
        backendId: 'media',
        key: 'thumbs/a_preview.jpeg',
        size: null,
        checksum: null,
        encryption: null,
      });
      expect(sut.getBackendFor(StorageBackendRole.Derived)).toBeUndefined();
    });

    it('should stage the file and store it under a new key on the configured backend', async () => {
      configureDerived();
      const output = await sut.createOutput(StorageBackendRole.Derived, '/data/thumbs/user/a_preview.webp');

      expect(output.path).toMatch(
        new RegExp(String.raw`^${join(directory, 'media', '.immich-staging')}/[0-9a-f-]{36}\.webp$`),
      );
      await fs.writeFile(output.path, 'preview');
      const stored = await output.commit();
      await output[Symbol.asyncDispose]();

      expect(stored).toEqual({
        backendId: 'derived',
        key: expect.stringMatching(/^[0-9a-f-]{36}$/),
        size: 7,
        checksum: createHash('sha1').update('preview').digest(),
        encryption: null,
      });
      await expect(fs.readFile(join(directory, 'derived', stored.key), 'utf8')).resolves.toBe('preview');
      await expect(fs.readdir(join(directory, 'media', '.immich-staging'))).resolves.toEqual([]);
    });

    it('should give every output a new key', async () => {
      configureDerived();
      const keys = [];
      for (let index = 0; index < 2; index++) {
        await using output = await sut.createOutput(StorageBackendRole.Derived, '/data/thumbs/a_preview.webp');
        await fs.writeFile(output.path, 'preview');
        const { key } = await output.commit();
        keys.push(key);
      }

      expect(keys[0]).not.toBe(keys[1]);
    });

    it('should remove a staged file that was not committed', async () => {
      configureDerived();
      {
        await using output = await sut.createOutput(StorageBackendRole.Derived, '/data/thumbs/a_preview.webp');
        await fs.writeFile(output.path, 'partial');
      }

      await expect(fs.readdir(join(directory, 'media', '.immich-staging'))).resolves.toEqual([]);
      await expect(fs.readdir(join(directory, 'derived')).catch(() => [])).resolves.toEqual([]);
    });
  });

  describe(toFileDeletion.name, () => {
    it('should delete recorded files by location and others by path', () => {
      expect(
        toFileDeletion([
          { path: '/data/a.jpg', backendId: 'media', key: 'a.jpg' },
          { path: '/data/b.jpg', backendId: null, key: null },
          { path: '', backendId: null, key: null },
          null,
          undefined,
        ]),
      ).toEqual({ files: ['/data/b.jpg'], locations: [{ backendId: 'media', key: 'a.jpg' }] });
    });
  });

  describe('files on a backend that does not keep them locally', () => {
    let directory: string;
    let local: LocalBlobStore;
    let remote: BlobStore;

    beforeEach(async () => {
      directory = await fs.mkdtemp(join(tmpdir(), 'immich-remote-'));
      StorageCore.setMediaLocation(join(directory, 'media'));
      local = new LocalBlobStore(join(directory, 'remote'));
      // a local store without local paths behaves like a remote one
      remote = {
        limits: local.limits,
        put: (key, body) => local.put(key, body),
        get: vi.fn((key, options) => local.get(key, options)),
        head: (key) => local.head(key),
        deleteMany: (keys) => local.deleteMany(keys),
        list: (prefix) => local.list(prefix),
      };
      vi.spyOn(sut, 'get').mockImplementation((backendId) => (backendId === 'remote' ? remote : local));
      (sut as unknown as { readRetryDelays: number[] }).readRetryDelays = [1, 1];
    });

    afterEach(async () => {
      await fs.rm(directory, { recursive: true, force: true });
    });

    const stagingFiles = () => fs.readdir(join(directory, 'media', '.immich-staging')).catch(() => []);

    it('should resolve a file to its blob and what reads are verified against', () => {
      const checksum = createHash('sha1').update('x').digest();
      expect(sut.resolve({ path: '/data/a.jpg', backendId: 'remote', key: 'a', size: '1', checksum })).toEqual({
        blob: { store: remote, key: 'a', expect: { size: 1, sha1: checksum } },
      });
      expect(
        sut.resolve({
          path: '/data/a.jpg',
          backendId: 'remote',
          key: 'a',
          size: 1,
          checksum: String.raw`\x${checksum.toString('hex')}`,
        }),
      ).toEqual({ blob: { store: remote, key: 'a', expect: { size: 1, sha1: checksum } } });
      expect(sut.toFileSource({ path: '/data/a.jpg', backendId: 'remote', key: 'a' })).toEqual({
        path: '/data/a.jpg',
        blob: { store: remote, key: 'a', expect: undefined },
      });
    });

    it('should lend a verified copy in the staging folder and remove it when the lease ends', async () => {
      const { size, sha1 } = await local.put('original', Readable.from([Buffer.from('original')]));

      {
        await using lease = await sut.lease({
          path: '/data/IMG_1.heic',
          backendId: 'remote',
          key: 'original',
          size,
          checksum: sha1,
        });
        expect(lease.path).toMatch(/\.immich-staging\/[0-9a-f-]{36}\.heic$/);
        await expect(fs.readFile(lease.path, 'utf8')).resolves.toBe('original');
      }

      await expect(stagingFiles()).resolves.toEqual([]);
    });

    it('should not lend a copy that does not match what was recorded', async () => {
      await local.put('original', Readable.from([Buffer.from('original')]));

      await expect(
        sut.lease({
          path: '/data/a.jpg',
          backendId: 'remote',
          key: 'original',
          size: 8,
          checksum: createHash('sha1').update('other').digest(),
        }),
      ).rejects.toThrow('checksum mismatch');
      await expect(stagingFiles()).resolves.toEqual([]);
    });

    it('should read a blob that is not readable yet again before giving up', async () => {
      await local.put('fresh', Readable.from([Buffer.from('fresh')]));
      vi.mocked(remote.get).mockRejectedValueOnce(new BlobNotFoundError('fresh'));

      await using lease = await sut.lease({ path: '/data/a.jpg', backendId: 'remote', key: 'fresh' });

      await expect(fs.readFile(lease.path, 'utf8')).resolves.toBe('fresh');
      expect(remote.get).toHaveBeenCalledTimes(2);
    });

    it('should give up on a blob that stays missing', async () => {
      await expect(sut.lease({ path: '/data/a.jpg', backendId: 'remote', key: 'missing' })).rejects.toThrow(
        BlobNotFoundError,
      );
      expect(remote.get).toHaveBeenCalledTimes(3);
      await expect(stagingFiles()).resolves.toEqual([]);
    });
  });

  describe('encryption', () => {
    let directory: string;
    let keys: MasterKeys;

    const encryptedBackend = (encrypted = true) => ({
      id: 'originals',
      driver: StorageBackendDriver.Local as const,
      role: StorageBackendRole.Originals,
      root: join(directory, 'originals'),
      encrypted,
    });

    const storeOriginal = async (content: string) => {
      const path = join(directory, 'upload.jpg');
      await fs.writeFile(path, content);
      return { path: '/data/upload/a.jpg', ...(await sut.storeFile(StorageBackendRole.Originals, path)) };
    };

    beforeEach(async () => {
      directory = await fs.mkdtemp(join(tmpdir(), 'immich-storage-encryption-'));
      StorageCore.setMediaLocation(join(directory, 'media'));
      keys = new MasterKeys([randomBytes(32)]);
    });

    afterEach(async () => {
      await fs.rm(directory, { recursive: true, force: true });
    });

    it('should need master keys for an encrypted backend', () => {
      expect(() => sut.configure([encryptedBackend()])).toThrow(
        'Storage backend originals is encrypted, but no master key is configured',
      );
      expect(() => sut.configure([encryptedBackend(false)])).not.toThrow();
    });

    it('should store files encrypted and record what reading them needs', async () => {
      sut.configure([encryptedBackend()], keys);
      const stored = await storeOriginal('original content');

      expect(stored).toEqual({
        path: '/data/upload/a.jpg',
        backendId: 'originals',
        key: expect.stringMatching(/^[0-9a-f-]{36}$/),
        size: 16,
        checksum: createHash('sha1').update('original content').digest(),
        encryption: expect.any(Buffer),
      });
      const raw = await fs.readFile(join(directory, 'originals', stored.key));
      expect(raw.includes(Buffer.from('original content'))).toBe(false);
    });

    it('should describe an encrypted file with its path in the object itself', async () => {
      sut.configure([encryptedBackend()], keys);
      const path = join(directory, 'upload.jpg');
      await fs.writeFile(path, 'original content');
      const stored = await sut.storeFile(StorageBackendRole.Originals, path, { originalFileName: 'IMG_1.jpg' });

      const blob = await fs.readFile(join(directory, 'originals', stored.key));
      const trailerLength = blob.readUInt32BE(blob.length - 4);
      const { manifest } = openTrailer(blob.subarray(-4 - trailerLength, -4), keys);
      expect(manifest).toEqual({
        path,
        originalFileName: 'IMG_1.jpg',
        key: stored.key,
        size: 16,
        sha1: stored.checksum!.toString('hex'),
      });
    });

    it('should read encrypted files through their store, even on a backend that keeps files locally', async () => {
      sut.configure([encryptedBackend()], keys);
      const stored = await storeOriginal('original content');

      const source = sut.resolve(stored);
      expect(source).toEqual({
        blob: {
          store: expect.anything(),
          key: stored.key,
          expect: { size: 16, sha1: stored.checksum },
          encryption: stored.encryption,
        },
      });
      expect(sut.toFileSource(stored)).toEqual({ path: '/data/upload/a.jpg', blob: expect.anything() });

      await using lease = await sut.lease(stored);
      await expect(fs.readFile(lease.path, 'utf8')).resolves.toBe('original content');
    });

    it('should decode what JSON columns hold as hex text', async () => {
      sut.configure([encryptedBackend()], keys);
      const stored = await storeOriginal('original content');

      await using lease = await sut.lease({
        ...stored,
        size: String(stored.size),
        checksum: String.raw`\x${stored.checksum!.toString('hex')}`,
        encryption: String.raw`\x${stored.encryption!.toString('hex')}`,
      });
      await expect(fs.readFile(lease.path, 'utf8')).resolves.toBe('original content');
    });

    it('should keep reading encrypted files after encryption was turned off for the backend', async () => {
      sut.configure([encryptedBackend()], keys);
      const encrypted = await storeOriginal('written encrypted');

      sut.configure([encryptedBackend(false)], keys);
      const plain = await storeOriginal('written plain');

      expect(plain.encryption).toBeNull();
      expect(sut.resolve(plain)).toEqual({ path: join(directory, 'originals', plain.key) });
      await using lease = await sut.lease(encrypted);
      await expect(fs.readFile(lease.path, 'utf8')).resolves.toBe('written encrypted');
    });

    it('should not read encrypted files without master keys', async () => {
      sut.configure([encryptedBackend()], keys);
      const stored = await storeOriginal('original content');

      sut.configure([encryptedBackend(false)]);
      expect(() => sut.resolve(stored)).toThrow(
        'Files on storage backend originals are encrypted, but no master key is configured',
      );
    });

    it('should not read an encrypted file without a recorded size', async () => {
      sut.configure([encryptedBackend()], keys);
      const stored = await storeOriginal('original content');

      expect(() => sut.resolve({ ...stored, size: null })).toThrow('has no recorded size');
    });

    it('should encrypt outputs on an encrypted backend', async () => {
      sut.configure([{ ...encryptedBackend(), id: 'derived', role: StorageBackendRole.Derived }], keys);
      await using output = await sut.createOutput(StorageBackendRole.Derived, '/data/thumbs/a_preview.webp');
      await fs.writeFile(output.path, 'preview');
      const stored = await output.commit();

      expect(stored.encryption).toEqual(expect.any(Buffer));
      await using lease = await sut.lease({ path: '/data/thumbs/a_preview.webp', ...stored });
      await expect(fs.readFile(lease.path, 'utf8')).resolves.toBe('preview');
    });

    it('should read master keys from a key file', async () => {
      const path = join(directory, 'master.key');
      const key = randomBytes(32);
      await fs.writeFile(path, `${key.toString('base64')}\n`);

      expect(sut.readMasterKeys(path).currentKeyId).toEqual(new MasterKeys([key]).currentKeyId);
    });
  });
});
