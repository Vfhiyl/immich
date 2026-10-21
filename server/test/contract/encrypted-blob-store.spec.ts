import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { BlobIntegrityError, BlobStore } from 'src/repositories/blob-store.js';
import { EncryptedBlobStore } from 'src/repositories/encrypted-blob-store.js';
import { MasterKeys } from 'src/repositories/key-provider.js';
import { S3_PART_SIZE } from 'src/repositories/s3-blob-store.js';
import { stores } from 'test/contract/stores.js';

/**
 * Encryption on top of every store: what the encrypted layer needs from a store (exact ranges, multipart uploads of
 * a stream whose length is not known up front) must hold for all of them.
 */
const sha1 = (value: Buffer) => createHash('sha1').update(value).digest();
const CHUNK = 64 * 1024;
const pieces = (value: Buffer, size: number) =>
  Readable.from(
    (function* () {
      for (let offset = 0; offset < value.length; offset += size) {
        yield value.subarray(offset, offset + size);
      }
    })(),
  );

describe.each(stores)('encrypted blob store: $name', ({ create }) => {
  let inner: BlobStore;
  let store: EncryptedBlobStore;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ store: inner, cleanup } = await create());
    store = new EncryptedBlobStore(inner, new MasterKeys([randomBytes(32)]));
  });

  afterAll(async () => {
    await cleanup();
  });

  it('should store and read back a blob larger than several parts', async () => {
    const content = randomBytes(2 * S3_PART_SIZE + 12_345);
    const { size, sha1: checksum, encryption } = await store.put('encrypted/large', pieces(content, 100_000));

    expect({ size, sha1: checksum }).toEqual({ size: content.length, sha1: sha1(content) });
    const read = await buffer(await store.get('encrypted/large', { encryption, expect: { size, sha1: checksum } }));
    expect(read.equals(content)).toBe(true);

    // the stored blob is larger by a tag per chunk and the trailer
    const stat = await inner.head('encrypted/large');
    expect(stat!.size).toBeGreaterThan(size + Math.ceil(size / CHUNK) * 16);
  });

  it('should read plaintext ranges across chunk and part boundaries', async () => {
    const content = randomBytes(S3_PART_SIZE + 3 * CHUNK);
    const { encryption } = await store.put('encrypted/ranges', pieces(content, 1_000_000));
    const expected = { size: content.length };

    for (const [start, end] of [
      [0, 0],
      [CHUNK - 1, CHUNK],
      [S3_PART_SIZE - 10, S3_PART_SIZE + 10],
      [S3_PART_SIZE + 2 * CHUNK + 5, content.length - 1],
      [content.length - 1, content.length - 1],
    ]) {
      const read = await buffer(
        await store.get('encrypted/ranges', { encryption, expect: expected, range: { start, end } }),
      );
      expect(read.equals(content.subarray(start, end + 1)), `${start}-${end}`).toBe(true);
    }
  });

  it('should store an empty blob', async () => {
    const { encryption } = await store.put('encrypted/empty', Readable.from([]));
    await expect(buffer(await store.get('encrypted/empty', { encryption, expect: { size: 0 } }))).resolves.toEqual(
      Buffer.alloc(0),
    );
  });

  it('should detect a blob that was replaced by another encrypted blob', async () => {
    const { encryption } = await store.put('encrypted/original', pieces(randomBytes(100), 10));
    await store.put('encrypted/other', pieces(randomBytes(100), 10));
    const other = await buffer(await inner.get('encrypted/other'));
    await inner.deleteMany(['encrypted/original']);
    await inner.put('encrypted/original', Readable.from([other]));

    const read = store
      .get('encrypted/original', { encryption, expect: { size: 100 } })
      .then((stream) => buffer(stream));
    await expect(read).rejects.toThrow(BlobIntegrityError);
  });

  describe('uploads in parts', () => {
    // 80 chunks of content, which are more than the 5 MiB every S3 service needs once encrypted
    const partSize = 80 * CHUNK;

    const uploadInParts = async (key: string, content: Buffer) => {
      const upload = await store.createUpload(key, { partSize });
      const count = Math.max(1, Math.ceil(content.length / partSize));
      const parts = [];
      for (let number = 1; number <= count; number++) {
        const data = content.subarray((number - 1) * partSize, number * partSize);
        const last = number === count ? { size: content.length, sha1: sha1(content) } : undefined;
        parts.push(await store.uploadPart(key, upload, { number, data, last }));
      }
      await store.completeUpload(key, upload, parts);
      return upload;
    };

    it.each([
      ['a blob of several parts', 2 * 80 * CHUNK + 4321],
      ['a blob of exactly two parts', 2 * 80 * CHUNK],
      ['an empty blob', 0],
    ])('should write and read %s', async (_, size) => {
      const content = randomBytes(size);
      const key = `encrypted/parts-${size}`;
      const { encryption } = await uploadInParts(key, content);

      const read = await buffer(await store.get(key, { encryption, expect: { size, sha1: sha1(content) } }));
      expect(read.equals(content)).toBe(true);
    });

    it('should read a range across parts', async () => {
      const content = randomBytes(partSize + 5000);
      const { encryption } = await uploadInParts('encrypted/parts-range', content);

      const range = { start: partSize - 100, end: partSize + 100 };
      const read = await buffer(
        await store.get('encrypted/parts-range', { encryption, expect: { size: content.length }, range }),
      );
      expect(read.equals(content.subarray(range.start, range.end + 1))).toBe(true);
    });

    it('should write a part again with the same result, from what the caller kept', async () => {
      const content = randomBytes(partSize + 10);
      const upload = await store.createUpload('encrypted/again', { partSize });
      const kept = { ...upload, encryption: Buffer.from(upload.encryption!) };
      const first = await store.uploadPart('encrypted/again', upload, {
        number: 1,
        data: content.subarray(0, partSize),
      });
      const again = await store.uploadPart('encrypted/again', kept, { number: 1, data: content.subarray(0, partSize) });
      const last = await store.uploadPart('encrypted/again', kept, {
        number: 2,
        data: content.subarray(partSize),
        last: { size: content.length, sha1: sha1(content) },
      });
      expect(again.size).toBe(first.size);

      await store.completeUpload('encrypted/again', kept, [again, last]);
      const read = await buffer(
        await store.get('encrypted/again', { encryption: upload.encryption, expect: { size: content.length } }),
      );
      expect(read.equals(content)).toBe(true);
    });
  });
});
