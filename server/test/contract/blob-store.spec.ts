import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import {
  BlobIntegrityError,
  BlobNotFoundError,
  BlobRangeError,
  BlobStore,
  BlobUploadNotFoundError,
} from 'src/repositories/blob-store.js';
import { S3BlobStore, S3_PART_SIZE } from 'src/repositories/s3-blob-store.js';
import { toClient } from 'test/contract/servers.js';
import { stores, targets } from 'test/contract/stores.js';

/**
 * The behavior every blob store must have, whatever stores the blobs. These tests are what lets the rest of the
 * server stay independent of storage services: any new backend has to pass them.
 */
const sha1 = (value: Buffer) => createHash('sha1').update(value).digest();
const toStream = (value: Buffer) => Readable.from([value]);
const chunked = (value: Buffer, size: number) =>
  Readable.from(
    (function* () {
      for (let offset = 0; offset < value.length; offset += size) {
        yield value.subarray(offset, offset + size);
      }
    })(),
  );

describe.each(stores)('blob store contract: $name', ({ create }) => {
  let store: BlobStore;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ store, cleanup } = await create());
  });

  afterAll(async () => {
    await cleanup();
  });

  const listAll = async (prefix?: string) => {
    const entries = await Array.fromAsync(store.list(prefix));
    return entries.toSorted((a, b) => a.key.localeCompare(b.key));
  };

  describe('put and get', () => {
    it('should store a blob and return its size and SHA-1', async () => {
      const content = randomBytes(1000);
      await expect(store.put('roundtrip/a', toStream(content))).resolves.toEqual({ size: 1000, sha1: sha1(content) });
      await expect(buffer(await store.get('roundtrip/a'))).resolves.toEqual(content);
    });

    it('should store an empty blob', async () => {
      await expect(store.put('empty', Readable.from([]))).resolves.toEqual({ size: 0, sha1: sha1(Buffer.alloc(0)) });
      await expect(buffer(await store.get('empty'))).resolves.toEqual(Buffer.alloc(0));
      await expect(store.head('empty')).resolves.toEqual({ size: 0 });
    });

    it('should store a blob larger than several parts from a stream of small chunks', async () => {
      const content = randomBytes(2 * S3_PART_SIZE + 1234);
      await expect(store.put('large', chunked(content, 64 * 1024))).resolves.toEqual({
        size: content.length,
        sha1: sha1(content),
      });

      const read = await buffer(await store.get('large', { expect: { size: content.length, sha1: sha1(content) } }));
      expect(read.equals(content)).toBe(true);
    });

    it('should store a blob of exactly one part', async () => {
      const content = randomBytes(S3_PART_SIZE);
      await store.put('one-part', toStream(content));
      await expect(store.head('one-part')).resolves.toEqual({ size: S3_PART_SIZE });
    });

    it.each(['IMG 1234 (1).HEIC', '照片/夏天.jpg', 'a+b=c&d.jpg'])('should keep the key %s', async (key) => {
      const content = randomBytes(10);
      await store.put(key, toStream(content));
      await expect(buffer(await store.get(key))).resolves.toEqual(content);
    });

    it('should reject an invalid key', async () => {
      await expect(store.put('../outside', toStream(Buffer.from('x')))).rejects.toThrow('Invalid blob key');
    });
  });

  describe('reading', () => {
    const content = Buffer.from('0123456789');

    beforeAll(async () => {
      await store.put('digits', toStream(content));
    });

    it('should read byte ranges', async () => {
      await expect(buffer(await store.get('digits', { range: { start: 2, end: 5 } }))).resolves.toEqual(
        Buffer.from('2345'),
      );
      await expect(buffer(await store.get('digits', { range: { start: 7 } }))).resolves.toEqual(Buffer.from('789'));
      await expect(buffer(await store.get('digits', { range: { start: 8, end: 99 } }))).resolves.toEqual(
        Buffer.from('89'),
      );
    });

    it('should reject a range past the end', async () => {
      await expect(store.get('digits', { range: { start: 10 } })).rejects.toThrow(BlobRangeError);
    });

    it('should reject a range that ends before it starts', async () => {
      await expect(store.get('digits', { range: { start: 5, end: 4 } })).rejects.toThrow(BlobRangeError);
    });

    it('should verify the expected size and checksum', async () => {
      await expect(buffer(await store.get('digits', { expect: { size: 10, sha1: sha1(content) } }))).resolves.toEqual(
        content,
      );
      await expect(store.get('digits', { expect: { size: 11 } })).rejects.toThrow(BlobIntegrityError);
      await expect(
        buffer(await store.get('digits', { expect: { size: 10, sha1: sha1(Buffer.from('x')) } })),
      ).rejects.toThrow('checksum mismatch');
    });

    it('should report a missing blob', async () => {
      await expect(store.get('missing')).rejects.toThrow(BlobNotFoundError);
      await expect(store.head('missing')).resolves.toBeNull();
    });
  });

  describe('deleting and listing', () => {
    it('should delete blobs and treat missing ones as deleted', async () => {
      await store.put('delete/a', toStream(Buffer.from('a')));
      await store.put('delete/b', toStream(Buffer.from('b')));

      await expect(store.deleteMany(['delete/a', 'delete/b', 'delete/missing'])).resolves.toEqual({ failed: [] });
      await expect(store.head('delete/a')).resolves.toBeNull();
      await expect(store.head('delete/b')).resolves.toBeNull();
    });

    it('should delete more blobs than fit in one batch', async () => {
      const keys = Array.from({ length: store.limits.maxDeleteBatch + 5 }, (_, index) => `batch/${index}`);
      await Promise.all(keys.slice(0, 10).map((key) => store.put(key, toStream(Buffer.from(key)))));

      await expect(store.deleteMany(keys)).resolves.toEqual({ failed: [] });
      await expect(listAll('batch/')).resolves.toEqual([]);
    });

    it('should list blobs below a prefix with their sizes', async () => {
      await store.put('list/u1/a', toStream(Buffer.from('1')));
      await store.put('list/u1/b', toStream(Buffer.from('22')));
      await store.put('list/u2/c', toStream(Buffer.from('333')));

      await expect(listAll('list/u1/')).resolves.toEqual([
        { key: 'list/u1/a', size: 1 },
        { key: 'list/u1/b', size: 2 },
      ]);
      await expect(listAll('list/u')).resolves.toHaveLength(3);
      await expect(listAll('list/none/')).resolves.toEqual([]);
    });
  });

  describe('uploads in parts', () => {
    // the smallest part every S3 service accepts
    const partSize = 5 * 1024 * 1024;

    it('should write a blob in parts, in any order and with parts written again', async () => {
      const content = randomBytes(2 * partSize + 1234);
      const upload = await store.createUpload('parts/a', { partSize });
      const slice = (number: number) => content.subarray((number - 1) * partSize, number * partSize);

      const third = await store.uploadPart('parts/a', upload, {
        number: 3,
        data: slice(3),
        last: { size: content.length, sha1: sha1(content) },
      });
      await store.uploadPart('parts/a', upload, { number: 1, data: randomBytes(partSize) });
      const first = await store.uploadPart('parts/a', upload, { number: 1, data: slice(1) });
      const second = await store.uploadPart('parts/a', upload, { number: 2, data: slice(2) });
      expect([first.size, second.size, third.size]).toEqual([partSize, partSize, 1234]);

      // nothing shows until the upload is complete
      await expect(store.head('parts/a')).resolves.toBeNull();
      await expect(listAll('parts/')).resolves.toEqual([]);

      await store.completeUpload('parts/a', upload, [first, second, third]);

      const read = await buffer(await store.get('parts/a', { expect: { size: content.length, sha1: sha1(content) } }));
      expect(read.equals(content)).toBe(true);
      await expect(listAll('parts/')).resolves.toEqual([{ key: 'parts/a', size: content.length }]);
    });

    it('should continue an upload with what the caller kept of it', async () => {
      const content = randomBytes(partSize + 10);
      const kept = JSON.parse(JSON.stringify(await store.createUpload('parts/kept', { partSize })));
      const first = await store.uploadPart('parts/kept', kept, { number: 1, data: content.subarray(0, partSize) });
      const second = await store.uploadPart('parts/kept', JSON.parse(JSON.stringify(kept)), {
        number: 2,
        data: content.subarray(partSize),
        last: { size: content.length, sha1: sha1(content) },
      });

      await store.completeUpload('parts/kept', kept, [first, second]);
      await expect(buffer(await store.get('parts/kept'))).resolves.toEqual(content);
    });

    it('should write a blob of one small part', async () => {
      const content = Buffer.from('small');
      const upload = await store.createUpload('parts/small', { partSize });
      const part = await store.uploadPart('parts/small', upload, {
        number: 1,
        data: content,
        last: { size: 5, sha1: sha1(content) },
      });
      await store.completeUpload('parts/small', upload, [part]);
      await expect(buffer(await store.get('parts/small'))).resolves.toEqual(content);
    });

    it('should drop an aborted upload, which takes no more parts', async () => {
      const upload = await store.createUpload('parts/aborted', { partSize });
      const part = await store.uploadPart('parts/aborted', upload, { number: 1, data: randomBytes(partSize) });

      await store.abortUpload('parts/aborted', upload);
      await store.abortUpload('parts/aborted', upload);

      await expect(
        store.uploadPart('parts/aborted', upload, { number: 2, data: randomBytes(partSize) }),
      ).rejects.toThrow(BlobUploadNotFoundError);
      await expect(store.completeUpload('parts/aborted', upload, [part])).rejects.toThrow(BlobUploadNotFoundError);
      await expect(store.head('parts/aborted')).resolves.toBeNull();
    });

    it('should report an upload that it does not know', async () => {
      const upload = await store.createUpload('parts/known', { partSize });
      const unknown = { ...upload, uploadId: randomUUID() };

      await expect(store.uploadPart('parts/known', unknown, { number: 1, data: randomBytes(10) })).rejects.toThrow(
        BlobUploadNotFoundError,
      );
      await store.abortUpload('parts/known', upload);
    });

    it('should reject a completion with a missing part', async () => {
      const upload = await store.createUpload('parts/missing', { partSize });
      const first = await store.uploadPart('parts/missing', upload, { number: 1, data: randomBytes(partSize) });
      const third = { number: 3, etag: first.etag, size: 10 };

      await expect(store.completeUpload('parts/missing', upload, [first, third])).rejects.toThrow();
      await expect(store.head('parts/missing')).resolves.toBeNull();
      await store.abortUpload('parts/missing', upload);
    });
  });
});

describe.each(targets)('S3 key prefixes: $name', (target) => {
  it('should keep blobs of different prefixes apart', async () => {
    const run = randomUUID();
    const first = new S3BlobStore(toClient(target), target.bucket, `prefix-${run}/first/`);
    const second = new S3BlobStore(toClient(target), target.bucket, `prefix-${run}/second/`);

    await first.put('same-key', toStream(Buffer.from('first')));
    await second.put('same-key', toStream(Buffer.from('second')));

    await expect(buffer(await first.get('same-key'))).resolves.toEqual(Buffer.from('first'));
    await expect(Array.fromAsync(second.list())).resolves.toEqual([{ key: 'same-key', size: 6 }]);
    await first.deleteMany(['same-key']);
    await expect(second.head('same-key')).resolves.toEqual({ size: 6 });
  });
});
