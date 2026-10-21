import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { BlobExistsError, BlobIntegrityError, BlobNotFoundError, BlobRangeError } from 'src/repositories/blob-store.js';
import { LOCAL_BLOB_TEMP_SUFFIX, LocalBlobStore } from 'src/repositories/local-blob-store.js';

const sha1 = (value: string | Buffer) => createHash('sha1').update(value).digest();
const toStream = (value: string | Buffer) => Readable.from([Buffer.from(value)]);

const listAll = async (sut: LocalBlobStore, prefix?: string) => {
  const entries = await Array.fromAsync(sut.list(prefix));
  return entries.sort((a, b) => a.key.localeCompare(b.key));
};

const filesUnder = async (directory: string): Promise<string[]> => {
  const entries = await fs.readdir(directory, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
};

describe(LocalBlobStore.name, () => {
  let root: string;
  let sut: LocalBlobStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'immich-local-blob-store-'));
    sut = new LocalBlobStore(root);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  describe('put', () => {
    it('should write the blob and return its size and checksum', async () => {
      await expect(sut.put('a/b/blob', toStream('hello world'))).resolves.toEqual({
        size: 11,
        sha1: sha1('hello world'),
      });

      await expect(fs.readFile(join(root, 'a', 'b', 'blob'), 'utf8')).resolves.toBe('hello world');
    });

    it('should write an empty blob', async () => {
      await expect(sut.put('empty', Readable.from([]))).resolves.toEqual({ size: 0, sha1: sha1('') });
      await expect(fs.readFile(join(root, 'empty'))).resolves.toEqual(Buffer.alloc(0));
    });

    it('should not overwrite an existing blob', async () => {
      await sut.put('blob', toStream('original'));

      await expect(sut.put('blob', toStream('replacement'))).rejects.toThrow(BlobExistsError);
      await expect(fs.readFile(join(root, 'blob'), 'utf8')).resolves.toBe('original');
      await expect(filesUnder(root)).resolves.toEqual([join(root, 'blob')]);
    });

    it('should leave nothing behind when the body fails', async () => {
      const body = Readable.from(
        (function* () {
          yield Buffer.from('partial');
          throw new Error('connection reset');
        })(),
      );

      await expect(sut.put('blob', body)).rejects.toThrow('connection reset');
      await expect(filesUnder(root)).resolves.toEqual([]);
    });

    it('should fall back to a rename when hard links are not supported', async () => {
      vi.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('not permitted'), { code: 'EPERM' }));

      await sut.put('blob', toStream('content'));

      await expect(fs.readFile(join(root, 'blob'), 'utf8')).resolves.toBe('content');
      await expect(filesUnder(root)).resolves.toEqual([join(root, 'blob')]);
    });

    it('should not overwrite an existing blob when hard links are not supported', async () => {
      await sut.put('blob', toStream('original'));
      vi.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('not permitted'), { code: 'EPERM' }));

      await expect(sut.put('blob', toStream('replacement'))).rejects.toThrow(BlobExistsError);
      await expect(fs.readFile(join(root, 'blob'), 'utf8')).resolves.toBe('original');
    });

    it('should rethrow unexpected errors when publishing', async () => {
      vi.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));

      await expect(sut.put('blob', toStream('content'))).rejects.toThrow('disk full');
      await expect(filesUnder(root)).resolves.toEqual([]);
    });

    it('should reject an invalid key before writing anything', async () => {
      await expect(sut.put('../outside', toStream('content'))).rejects.toThrow('Invalid blob key');
      await expect(fs.access(join(root, '..', 'outside'))).rejects.toThrow();
    });
  });

  describe('get', () => {
    beforeEach(async () => {
      await sut.put('blob', toStream('0123456789'));
    });

    it('should read the whole blob', async () => {
      await expect(buffer(await sut.get('blob'))).resolves.toEqual(Buffer.from('0123456789'));
    });

    it('should read a byte range', async () => {
      await expect(buffer(await sut.get('blob', { range: { start: 2, end: 5 } }))).resolves.toEqual(
        Buffer.from('2345'),
      );
    });

    it('should read from an offset to the end', async () => {
      await expect(buffer(await sut.get('blob', { range: { start: 7 } }))).resolves.toEqual(Buffer.from('789'));
    });

    it('should reject an unsatisfiable range', async () => {
      await expect(sut.get('blob', { range: { start: 10 } })).rejects.toThrow(BlobRangeError);
    });

    it('should throw a not found error for a missing blob', async () => {
      await expect(sut.get('missing')).rejects.toThrow(BlobNotFoundError);
    });

    it('should treat a directory as not found', async () => {
      await fs.mkdir(join(root, 'directory'));
      await expect(sut.get('directory')).rejects.toThrow(BlobNotFoundError);
    });

    it('should verify the whole blob against the expected size and checksum', async () => {
      const stream = await sut.get('blob', { expect: { size: 10, sha1: sha1('0123456789') } });
      await expect(buffer(stream)).resolves.toEqual(Buffer.from('0123456789'));
    });

    it('should fail before reading when the blob size differs from the expected size', async () => {
      await expect(sut.get('blob', { expect: { size: 11 } })).rejects.toThrow(BlobIntegrityError);
    });

    it('should fail the stream when the checksum does not match', async () => {
      const stream = await sut.get('blob', { expect: { size: 10, sha1: sha1('0123456780') } });
      await expect(buffer(stream)).rejects.toThrow('checksum mismatch');
    });

    it('should verify the length of a range read', async () => {
      const stream = await sut.get('blob', { range: { start: 2, end: 5 }, expect: { size: 10, sha1: sha1('x') } });
      // the checksum covers the whole blob, so only the length is checked for a range
      await expect(buffer(stream)).resolves.toEqual(Buffer.from('2345'));
    });

    it('should fail the stream when the file shrinks while it is being read', async () => {
      const stream = await sut.get('blob', { expect: { size: 10 } });
      await fs.truncate(join(root, 'blob'), 4);
      await expect(buffer(stream)).rejects.toThrow(BlobIntegrityError);
    });
  });

  describe('head', () => {
    it('should return the size of a blob', async () => {
      await sut.put('blob', toStream('12345'));
      await expect(sut.head('blob')).resolves.toEqual({ size: 5 });
    });

    it('should return null for a missing blob', async () => {
      await expect(sut.head('missing')).resolves.toBeNull();
    });

    it('should return null when a parent is a file', async () => {
      await sut.put('file', toStream('content'));
      await expect(sut.head('file/child')).resolves.toBeNull();
    });

    it('should reject an invalid key', async () => {
      await expect(sut.head('/absolute')).rejects.toThrow('Invalid blob key');
    });
  });

  describe('deleteMany', () => {
    it('should delete blobs', async () => {
      await sut.put('a', toStream('a'));
      await sut.put('b/c', toStream('c'));

      await expect(sut.deleteMany(['a', 'b/c'])).resolves.toEqual({ failed: [] });
      await expect(filesUnder(root)).resolves.toEqual([]);
    });

    it('should treat a blob that is already gone as deleted', async () => {
      await expect(sut.deleteMany(['missing', 'missing/child'])).resolves.toEqual({ failed: [] });
    });

    it('should report keys that could not be deleted and continue with the rest', async () => {
      await fs.mkdir(join(root, 'directory'));
      await sut.put('blob', toStream('content'));

      await expect(sut.deleteMany(['directory', 'blob'])).resolves.toEqual({ failed: ['directory'] });
      await expect(sut.head('blob')).resolves.toBeNull();
    });

    it('should validate every key before deleting any', async () => {
      await sut.put('blob', toStream('content'));

      await expect(sut.deleteMany(['blob', '../outside'])).rejects.toThrow('Invalid blob key');
      await expect(sut.head('blob')).resolves.toEqual({ size: 7 });
    });
  });

  describe('getLocalPath', () => {
    it('should return the path of a blob below the root', () => {
      expect(sut.getLocalPath('a/b/blob')).toBe(join(root, 'a', 'b', 'blob'));
    });

    it('should reject an invalid key', () => {
      expect(() => sut.getLocalPath('../outside')).toThrow('Invalid blob key');
    });
  });

  describe('list', () => {
    beforeEach(async () => {
      await sut.put('upload/u1/aa/one', toStream('1'));
      await sut.put('upload/u1/ab/two', toStream('22'));
      await sut.put('upload/u2/aa/three', toStream('333'));
      await sut.put('thumbs/u1/four', toStream('4444'));
    });

    it('should list every blob', async () => {
      await expect(listAll(sut)).resolves.toEqual([
        { key: 'thumbs/u1/four', size: 4, lastModified: expect.any(Date) },
        { key: 'upload/u1/aa/one', size: 1, lastModified: expect.any(Date) },
        { key: 'upload/u1/ab/two', size: 2, lastModified: expect.any(Date) },
        { key: 'upload/u2/aa/three', size: 3, lastModified: expect.any(Date) },
      ]);
    });

    it('should list blobs below a directory prefix', async () => {
      await expect(listAll(sut, 'upload/u1/')).resolves.toEqual([
        { key: 'upload/u1/aa/one', size: 1, lastModified: expect.any(Date) },
        { key: 'upload/u1/ab/two', size: 2, lastModified: expect.any(Date) },
      ]);
    });

    it('should match a partial name prefix', async () => {
      await expect(listAll(sut, 'upload/u1/a')).resolves.toEqual([
        { key: 'upload/u1/aa/one', size: 1, lastModified: expect.any(Date) },
        { key: 'upload/u1/ab/two', size: 2, lastModified: expect.any(Date) },
      ]);
      await expect(listAll(sut, 'upload/u')).resolves.toHaveLength(3);
    });

    it('should return nothing for a prefix that does not exist', async () => {
      await expect(listAll(sut, 'missing/')).resolves.toEqual([]);
    });

    it('should skip in-progress writes', async () => {
      await fs.writeFile(join(root, 'upload', 'u1', 'aa', `one.partial${LOCAL_BLOB_TEMP_SUFFIX}`), 'partial');
      await expect(listAll(sut, 'upload/u1/aa/')).resolves.toEqual([
        { key: 'upload/u1/aa/one', size: 1, lastModified: expect.any(Date) },
      ]);
    });

    it('should reject an invalid prefix', async () => {
      await expect(listAll(sut, '../')).rejects.toThrow('Invalid blob prefix');
    });
  });
});
