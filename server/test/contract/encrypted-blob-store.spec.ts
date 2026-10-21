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
});
