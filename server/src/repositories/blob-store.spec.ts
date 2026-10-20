import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import {
  BlobIntegrityError,
  BlobRangeError,
  assertValidBlobKey,
  assertValidBlobPrefix,
  createVerifyingStream,
  resolveBlobRange,
} from 'src/repositories/blob-store.js';

const sha1 = (value: string | Buffer) => createHash('sha1').update(value).digest();

const readThrough = (chunks: string[], expected: { length?: number; sha1?: Buffer }) =>
  buffer(Readable.from(chunks.map((chunk) => Buffer.from(chunk))).pipe(createVerifyingStream('key', expected)));

describe('blob store helpers', () => {
  describe(assertValidBlobKey.name, () => {
    it.each([
      '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90',
      'upload/user-id/3f/2a/3f2a9c1e.jpg',
      'library/admin/2024/2024-05-01/IMG 1234 (1).HEIC',
      'library/admin/照片/夏天.jpg',
      String.raw`mnt/photos/a\b.jpg`,
      `mnt/${'a'.repeat(2000)}`,
      '.immich',
    ])('should accept %s', (key) => {
      expect(() => assertValidBlobKey(key)).not.toThrow();
    });

    it.each([
      ['an empty key', ''],
      ['an absolute path', '/etc/passwd'],
      ['a parent segment', '../outside'],
      ['a nested parent segment', 'upload/../../outside'],
      ['a current directory segment', './file'],
      ['a trailing current directory segment', 'upload/.'],
      ['an empty segment', 'upload//file'],
      ['a trailing slash', 'upload/'],
      ['a null byte', 'upload/file\0'],
    ])('should reject %s', (_, key) => {
      expect(() => assertValidBlobKey(key)).toThrow('Invalid blob key');
    });
  });

  describe(assertValidBlobPrefix.name, () => {
    it.each(['', 'upload', 'upload/', 'upload/user-id/3f'])('should accept %j', (prefix) => {
      expect(() => assertValidBlobPrefix(prefix)).not.toThrow();
    });

    it.each(['/', '/upload', '../upload', 'upload//', 'upload/../x/'])('should reject %j', (prefix) => {
      expect(() => assertValidBlobPrefix(prefix)).toThrow('Invalid blob prefix');
    });
  });

  describe(resolveBlobRange.name, () => {
    it('should default the end to the last byte', () => {
      expect(resolveBlobRange('key', { start: 2 }, 10)).toEqual({ start: 2, end: 9, length: 8 });
    });

    it('should clamp an end past the last byte', () => {
      expect(resolveBlobRange('key', { start: 0, end: 99 }, 10)).toEqual({ start: 0, end: 9, length: 10 });
    });

    it('should support a single byte', () => {
      expect(resolveBlobRange('key', { start: 9, end: 9 }, 10)).toEqual({ start: 9, end: 9, length: 1 });
    });

    it.each([
      ['a start past the last byte', { start: 10 }, 10],
      ['a negative start', { start: -1 }, 10],
      ['a fractional start', { start: 1.5 }, 10],
      ['an end before the start', { start: 5, end: 4 }, 10],
      ['any range of an empty blob', { start: 0 }, 0],
    ])('should reject %s', (_, range, size) => {
      expect(() => resolveBlobRange('key', range, size)).toThrow(BlobRangeError);
    });
  });

  describe(createVerifyingStream.name, () => {
    it('should pass data through unchanged when nothing is expected', async () => {
      await expect(readThrough(['ab', 'cd'], {})).resolves.toEqual(Buffer.from('abcd'));
    });

    it('should pass data through when the length and checksum match', async () => {
      await expect(readThrough(['ab', 'cd'], { length: 4, sha1: sha1('abcd') })).resolves.toEqual(Buffer.from('abcd'));
    });

    it('should fail when fewer bytes than expected arrive', async () => {
      await expect(readThrough(['ab'], { length: 4 })).rejects.toThrow(BlobIntegrityError);
    });

    it('should fail as soon as more bytes than expected arrive', async () => {
      await expect(readThrough(['abc', 'de'], { length: 4 })).rejects.toThrow('expected 4 bytes but read more');
    });

    it('should fail when the checksum does not match', async () => {
      await expect(readThrough(['abcd'], { length: 4, sha1: sha1('abce') })).rejects.toThrow('checksum mismatch');
    });

    it('should verify an empty stream', async () => {
      await expect(readThrough([], { length: 0, sha1: sha1('') })).resolves.toEqual(Buffer.alloc(0));
    });
  });
});
