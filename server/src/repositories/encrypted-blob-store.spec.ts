import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import {
  BlobIntegrityError,
  BlobNotFoundError,
  BlobRange,
  BlobRangeError,
  BlobStore,
} from 'src/repositories/blob-store.js';
import {
  ENCRYPTION_HEADER_LENGTH,
  EncryptedBlobStore,
  EncryptionSuite,
  decodeEncryptionHeader,
  encodeEncryptionHeader,
  unwrapKey,
  wrapKey,
} from 'src/repositories/encrypted-blob-store.js';
import { MasterKeys, getMasterKeyId } from 'src/repositories/key-provider.js';
import { LocalBlobStore } from 'src/repositories/local-blob-store.js';

const CHUNK = 64 * 1024;
const sha1 = (value: Buffer) => createHash('sha1').update(value).digest();
const toStream = (value: Buffer) => Readable.from([value]);
const pieces = (value: Buffer, size: number) =>
  Readable.from(
    (function* () {
      for (let offset = 0; offset < value.length; offset += size) {
        yield value.subarray(offset, offset + size);
      }
    })(),
  );

/**
 * Decodes a stored blob with node crypto alone, following the documented format rather than the code under test, so
 * that the format is what the tests pin down.
 */
const decodeIndependently = (blob: Buffer, masterKey: Buffer, key: string) => {
  const trailerLength = blob.readUInt32BE(blob.length - 4);
  const trailer = blob.subarray(-4 - trailerLength, -4);
  const header = trailer.subarray(0, 66);
  expect(header.subarray(0, 8).toString()).toBe('IMMENC01');
  expect(header[8]).toBe(1);
  const algorithm = header[9] === 1 ? 'aes-256-gcm' : 'chacha20-poly1305';
  const chunkSize = 2 ** header[10];
  const prefix = header.subarray(11, 18);
  expect(header.subarray(18, 26)).toEqual(getMasterKeyId(masterKey));

  const unwrap = createDecipheriv('id-aes256-wrap', masterKey, Buffer.from('A6A6A6A6A6A6A6A6', 'hex'));
  const fileKey = Buffer.concat([unwrap.update(header.subarray(26, 66)), unwrap.final()]);

  const open = (nonce: Buffer, aad: Buffer, sealed: Buffer) => {
    const decipher =
      algorithm === 'aes-256-gcm'
        ? createDecipheriv(algorithm, fileKey, nonce, { authTagLength: 16 })
        : createDecipheriv(algorithm, fileKey, nonce, { authTagLength: 16 });
    decipher.setAAD(aad, { plaintextLength: sealed.length - 16 });
    decipher.setAuthTag(sealed.subarray(-16));
    return Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
  };
  const nonce = (index: number, flag: number) => {
    const value = Buffer.alloc(12);
    prefix.copy(value);
    value.writeUInt32BE(index, 7);
    value[11] = flag;
    return value;
  };

  const manifest = JSON.parse(open(nonce(0, 2), header, trailer.subarray(66)).toString('utf8'));
  const data = blob.subarray(0, blob.length - 4 - trailerLength);
  const aad = Buffer.concat([header, Buffer.from(key)]);
  const plaintext: Buffer[] = [];
  const count = Math.max(1, Math.ceil(manifest.size / chunkSize));
  for (let index = 0, offset = 0; index < count; index++) {
    const length = Math.min(chunkSize, manifest.size - index * chunkSize) + 16;
    plaintext.push(open(nonce(index, index === count - 1 ? 1 : 0), aad, data.subarray(offset, offset + length)));
    offset += length;
  }
  return { header, manifest, plaintext: Buffer.concat(plaintext) };
};

describe(EncryptedBlobStore.name, () => {
  let root: string;
  let inner: LocalBlobStore;
  let masterKey: Buffer;
  let sut: EncryptedBlobStore;

  const stored = async (key: string) => buffer(await inner.get(key));
  const rewrite = async (key: string, change: (blob: Buffer) => Buffer) => {
    const blob = await stored(key);
    await inner.deleteMany([key]);
    await inner.put(key, toStream(change(Buffer.from(blob))));
  };
  const write = async (key: string, content: Buffer) => {
    const { encryption } = await sut.put(key, toStream(content));
    return { encryption, expect: { size: content.length, sha1: sha1(content) } };
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'immich-encrypted-blob-store-'));
    inner = new LocalBlobStore(root);
    masterKey = randomBytes(32);
    sut = new EncryptedBlobStore(inner, new MasterKeys([masterKey]));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  describe('key wrapping', () => {
    it('should follow AES key wrap (RFC 3394, 4.6: 256-bit key with a 256-bit key)', () => {
      const kek = Buffer.from('000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F', 'hex');
      const key = Buffer.from('00112233445566778899AABBCCDDEEFF000102030405060708090A0B0C0D0E0F', 'hex');
      const wrapped = '28C9F404C4B810F4CBCCB35CFB87F8263F5786E2D80ED326CBC7F0E71A99F43BFB988B9B7A02DD21';

      expect(wrapKey(kek, key).toString('hex').toUpperCase()).toBe(wrapped);
      expect(unwrapKey(kek, Buffer.from(wrapped, 'hex'))).toEqual(key);
    });

    it('should not unwrap with another master key', () => {
      const wrapped = wrapKey(randomBytes(32), randomBytes(32));
      expect(() => unwrapKey(randomBytes(32), wrapped)).toThrow('Unable to unwrap');
    });
  });

  describe('header', () => {
    const header = {
      suite: EncryptionSuite.Aes256Gcm,
      chunkSizeLog: 16,
      noncePrefix: Buffer.alloc(7, 1),
      masterKeyId: Buffer.alloc(8, 2),
      wrappedKey: Buffer.alloc(40, 3),
    };

    it('should encode and decode', () => {
      const encoded = encodeEncryptionHeader(header);
      expect(encoded).toHaveLength(ENCRYPTION_HEADER_LENGTH);
      expect(ENCRYPTION_HEADER_LENGTH).toBe(66);
      expect(decodeEncryptionHeader(encoded)).toEqual(header);
    });

    it.each([
      ['a wrong length', (value: Buffer) => value.subarray(1)],
      ['another magic', (value: Buffer) => Buffer.concat([Buffer.from('IMMENC02'), value.subarray(8)])],
      ['another version', (value: Buffer) => Object.assign(Buffer.from(value), { 8: 2 })],
      ['an unknown suite', (value: Buffer) => Object.assign(Buffer.from(value), { 9: 3 })],
      ['an implausible chunk size', (value: Buffer) => Object.assign(Buffer.from(value), { 10: 40 })],
    ])('should reject %s', (_, change) => {
      expect(() => decodeEncryptionHeader(change(encodeEncryptionHeader(header)))).toThrow(
        'Not a supported encryption header',
      );
    });
  });

  describe('put', () => {
    it('should return the size and checksum of the plaintext and the header to record', async () => {
      const content = randomBytes(1000);
      const result = await sut.put('blob', toStream(content));

      expect(result).toEqual({ size: 1000, sha1: sha1(content), encryption: expect.any(Buffer) });
      expect(decodeEncryptionHeader(result.encryption!)).toMatchObject({
        suite: EncryptionSuite.Aes256Gcm,
        chunkSizeLog: 16,
        masterKeyId: getMasterKeyId(masterKey),
      });
    });

    it('should store chunks, a trailer and its length, without the plaintext', async () => {
      const content = Buffer.alloc(3 * CHUNK + 5, 'secret ');
      const { encryption } = await sut.put('blob', toStream(content), { manifest: { assetId: 'asset-1' } });
      const blob = await stored('blob');

      expect(blob.includes(Buffer.from('secret secret'))).toBe(false);
      const trailerLength = blob.readUInt32BE(blob.length - 4);
      expect(blob.length).toBe(content.length + 4 * 16 + trailerLength + 4);
      expect(blob.subarray(-4 - trailerLength, -4 - trailerLength + 66)).toEqual(encryption);
    });

    it('should be readable from the stored blob and the master key alone', async () => {
      const content = randomBytes(2 * CHUNK + 17);
      const { encryption } = await sut.put('a/blob', toStream(content), { manifest: { assetId: 'asset-1' } });
      const decoded = decodeIndependently(await stored('a/blob'), masterKey, 'a/blob');

      expect(decoded.header).toEqual(encryption);
      expect(decoded.plaintext).toEqual(content);
      expect(decoded.manifest).toEqual({
        assetId: 'asset-1',
        key: 'a/blob',
        size: content.length,
        sha1: sha1(content).toString('hex'),
      });
    });

    it('should use a new file key and nonce prefix for every blob', async () => {
      const content = randomBytes(100);
      const first = await sut.put('first', toStream(content));
      const second = await sut.put('second', toStream(content));

      const [a, b] = [first, second].map(({ encryption }) => decodeEncryptionHeader(encryption!));
      expect(a.noncePrefix.equals(b.noncePrefix)).toBe(false);
      expect(a.wrappedKey.equals(b.wrappedKey)).toBe(false);
      const [storedFirst, storedSecond] = await Promise.all([stored('first'), stored('second')]);
      expect(storedFirst.subarray(0, 100).equals(storedSecond.subarray(0, 100))).toBe(false);
    });

    it('should accept streams of strings', async () => {
      const { encryption } = await sut.put('text', Readable.from(['hello ', 'world']));
      const stream = await sut.get('text', { encryption, expect: { size: 11 } });
      await expect(buffer(stream)).resolves.toEqual(Buffer.from('hello world'));
    });

    it('should pass a size hint for the encrypted blob', async () => {
      const put = vi.spyOn(inner as BlobStore, 'put');
      await sut.put('hinted', toStream(randomBytes(10)), { sizeHint: 10 });
      expect(put).toHaveBeenCalledWith('hinted', expect.anything(), { sizeHint: expect.any(Number) });
      const stat = await inner.head('hinted');
      expect(put.mock.calls[0][2]!.sizeHint).toBeGreaterThanOrEqual(stat!.size);
    });

    it('should not overwrite an existing blob', async () => {
      await sut.put('once', toStream(Buffer.from('a')));
      await expect(sut.put('once', toStream(Buffer.from('b')))).rejects.toThrow();
    });
  });

  describe('get', () => {
    it.each([0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK, 3 * CHUNK + 5])(
      'should read back a blob of %i bytes',
      async (size) => {
        const content = randomBytes(size);
        const { encryption } = await sut.put('blob', pieces(content, 1000));
        const stream = await sut.get('blob', { encryption, expect: { size, sha1: sha1(content) } });
        await expect(buffer(stream)).resolves.toEqual(content);
        expect(decodeIndependently(await stored('blob'), masterKey, 'blob').plaintext).toEqual(content);
      },
    );

    it('should read back a blob that arrived in pieces larger than a chunk', async () => {
      const content = randomBytes(5 * CHUNK + 3);
      const { encryption } = await sut.put('blob', pieces(content, 2 * CHUNK + 7));
      await expect(buffer(await sut.get('blob', { encryption, expect: { size: content.length } }))).resolves.toEqual(
        content,
      );
    });

    describe('ranges', () => {
      const size = 3 * CHUNK + 5;
      const content = randomBytes(size);
      const positions = [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK - 1, 2 * CHUNK, 3 * CHUNK, size - 2, size - 1];
      const ranges = positions.flatMap((start) =>
        positions.filter((end) => end >= start).map((end) => ({ start, end })),
      );

      it('should read any range of the plaintext', async () => {
        const { encryption, expect: expected } = await write('ranged', content);
        for (const range of ranges) {
          const stream = await sut.get('ranged', { encryption, expect: expected, range });
          const read = await buffer(stream);
          expect(read.equals(content.subarray(range.start, range.end + 1)), JSON.stringify(range)).toBe(true);
        }
      });

      it('should read ranges without an end, or with an end past the last byte', async () => {
        const { encryption, expect: expected } = await write('ranged', content);
        const open = await sut.get('ranged', { encryption, expect: expected, range: { start: CHUNK + 3 } });
        await expect(buffer(open)).resolves.toEqual(content.subarray(CHUNK + 3));
        const clamped = await sut.get('ranged', { encryption, expect: expected, range: { start: 5, end: size * 2 } });
        await expect(buffer(clamped)).resolves.toEqual(content.subarray(5));
      });

      it('should only read the chunks that hold the range', async () => {
        const { encryption, expect: expected } = await write('ranged', content);
        const get = vi.spyOn(inner, 'get');

        await buffer(
          await sut.get('ranged', { encryption, expect: expected, range: { start: CHUNK + 1, end: CHUNK + 2 } }),
        );
        expect(get).toHaveBeenCalledWith('ranged', { range: { start: CHUNK + 16, end: 2 * (CHUNK + 16) - 1 } });

        await buffer(await sut.get('ranged', { encryption, expect: expected, range: { start: size - 1 } }));
        expect(get).toHaveBeenLastCalledWith('ranged', {
          range: { start: 3 * (CHUNK + 16), end: 3 * (CHUNK + 16) + 5 + 16 - 1 },
        });
      });

      it('should reject a range past the end', async () => {
        const { encryption, expect: expected } = await write('ranged', content);
        await expect(sut.get('ranged', { encryption, expect: expected, range: { start: size } })).rejects.toThrow(
          BlobRangeError,
        );
        await expect(sut.get('ranged', { encryption, expect: expected, range: { start: 9, end: 8 } })).rejects.toThrow(
          BlobRangeError,
        );
      });
    });

    it('should need the recorded header and size', async () => {
      const { encryption, expect: expected } = await write('blob', randomBytes(10));
      await expect(sut.get('blob')).rejects.toThrow('needs its recorded encryption header and size');
      await expect(sut.get('blob', { encryption })).rejects.toThrow('needs its recorded encryption header and size');
      await expect(sut.get('blob', { expect: expected })).rejects.toThrow('needs');
    });

    it('should report a missing blob', async () => {
      const { encryption } = await write('blob', randomBytes(10));
      await expect(sut.get('other', { encryption, expect: { size: 10 } })).rejects.toThrow(BlobNotFoundError);
    });

    it('should verify the checksum of a whole read', async () => {
      const { encryption } = await write('blob', randomBytes(10));
      const stream = await sut.get('blob', { encryption, expect: { size: 10, sha1: sha1(randomBytes(10)) } });
      await expect(buffer(stream)).rejects.toThrow('checksum mismatch');
    });

    it.each([-1, 1, CHUNK])('should fail when the recorded size is off by %i', async (offset) => {
      const content = randomBytes(CHUNK + 10);
      const { encryption } = await write('blob', content);
      const read = sut
        .get('blob', { encryption, expect: { size: content.length + offset } })
        .then((stream) => buffer(stream));
      await expect(read).rejects.toThrow();
    });

    it('should read blobs written with a previous master key', async () => {
      const content = randomBytes(100);
      const { encryption, expect: expected } = await write('blob', content);
      const rotated = new EncryptedBlobStore(inner, new MasterKeys([randomBytes(32), masterKey]));

      await expect(buffer(await rotated.get('blob', { encryption, expect: expected }))).resolves.toEqual(content);
      const written = await rotated.put('new', toStream(content));
      expect(decodeEncryptionHeader(written.encryption!).masterKeyId).not.toEqual(getMasterKeyId(masterKey));
    });

    it('should not read without the master key the blob was written with', async () => {
      const { encryption, expect: expected } = await write('blob', randomBytes(100));
      const other = new EncryptedBlobStore(inner, new MasterKeys([randomBytes(32)]));
      await expect(other.get('blob', { encryption, expect: expected })).rejects.toThrow('is not available');
    });

    it('should read with the ChaCha20-Poly1305 suite', async () => {
      const chacha = new EncryptedBlobStore(inner, new MasterKeys([masterKey]), {
        suite: EncryptionSuite.ChaCha20Poly1305,
      });
      const content = randomBytes(2 * CHUNK + 1);
      const { encryption } = await chacha.put('chacha', toStream(content));

      expect(decodeEncryptionHeader(encryption!).suite).toBe(EncryptionSuite.ChaCha20Poly1305);
      // the suite is recorded, so any store reads it
      const read = await sut.get('chacha', { encryption, expect: { size: content.length, sha1: sha1(content) } });
      await expect(buffer(read)).resolves.toEqual(content);
      expect(decodeIndependently(await stored('chacha'), masterKey, 'chacha').plaintext).toEqual(content);
    });
  });

  describe('format', () => {
    // a blob built with node crypto alone (master key 32 × 0x07, file key 32 × 0x09, nonce prefix 01…07), which
    // every later version must still read
    const vector = {
      key: 'vector/blob',
      blob:
        '7AFxHw82EvUbw7zoNU/EEj/0YE12fgm0E5kmR28PZgkDVMv/zWoEnpeMgo03SU1NRU5DMDEBARABAgMEBQYH5TO9IiAhERwLjVcItr+lW96QX0' +
        'EWrhr6E0m1c3yBc+7Zd3D1xrsoLGN0iTk6mbiXTCCyaRaH3VzxZgH1fNl0oBF0pB2uu50hSZP34KrADYFwUEYiL2Qwn8+MI5LsQ3OCKEk8Q2e7T4' +
        'z35SO0RI3/uxCmWYmZKn7rIACFlicdbwUNqRmg/2ARBoF46kxgmTPRFQAAAKM=',
      header: 'SU1NRU5DMDEBARABAgMEBQYH5TO9IiAhERwLjVcItr+lW96QX0EWrhr6E0m1c3yBc+7Zd3D1xrsoLGN0iTk6mbiX',
      plaintext: 'immich encryption test vector',
    };

    it('should read a blob of the first format version', async () => {
      await inner.put(vector.key, toStream(Buffer.from(vector.blob, 'base64')));
      const store = new EncryptedBlobStore(inner, new MasterKeys([Buffer.alloc(32, 7)]));
      const plaintext = Buffer.from(vector.plaintext);

      const stream = await store.get(vector.key, {
        encryption: Buffer.from(vector.header, 'base64'),
        expect: { size: plaintext.length, sha1: sha1(plaintext) },
      });
      await expect(buffer(stream)).resolves.toEqual(plaintext);
      expect(decodeIndependently(Buffer.from(vector.blob, 'base64'), Buffer.alloc(32, 7), vector.key).manifest).toEqual(
        {
          key: vector.key,
          size: plaintext.length,
          sha1: sha1(plaintext).toString('hex'),
        },
      );
    });
  });

  describe('tampering', () => {
    const content = randomBytes(3 * CHUNK + 5);
    const readAll = async (key: string, encryption: Buffer | undefined, size = content.length, range?: BlobRange) =>
      buffer(await sut.get(key, { encryption, expect: { size }, range }));

    it('should detect a changed byte', async () => {
      const { encryption } = await write('blob', content);
      await rewrite('blob', (blob) => Object.assign(blob, { [CHUNK + 100]: blob[CHUNK + 100] ^ 1 }));

      await expect(readAll('blob', encryption)).rejects.toThrow(BlobIntegrityError);
      // the chunks before it still read
      await expect(readAll('blob', encryption, content.length, { start: 0, end: CHUNK - 1 })).resolves.toEqual(
        content.subarray(0, CHUNK),
      );
    });

    it('should detect swapped chunks', async () => {
      const { encryption } = await write('blob', content);
      const sealed = CHUNK + 16;
      await rewrite('blob', (blob) =>
        Buffer.concat([blob.subarray(sealed, 2 * sealed), blob.subarray(0, sealed), blob.subarray(2 * sealed)]),
      );

      await expect(readAll('blob', encryption, content.length, { start: 0, end: 10 })).rejects.toThrow(
        BlobIntegrityError,
      );
    });

    it('should detect a blob cut after a whole chunk, even with a matching recorded size', async () => {
      const { encryption } = await write('blob', content);
      await rewrite('blob', (blob) => blob.subarray(0, CHUNK + 16));

      await expect(readAll('blob', encryption, CHUNK)).rejects.toThrow(BlobIntegrityError);
    });

    it('should detect a blob that ends early', async () => {
      const { encryption } = await write('blob', content);
      await rewrite('blob', (blob) => blob.subarray(0, 2 * (CHUNK + 16)));

      await expect(readAll('blob', encryption)).rejects.toThrow();
    });

    it('should detect a blob moved to another key', async () => {
      const { encryption } = await write('blob', content);
      await inner.put('moved', toStream(await stored('blob')));

      await expect(readAll('moved', encryption)).rejects.toThrow(BlobIntegrityError);
    });

    it('should detect a changed header', async () => {
      const { encryption } = await write('blob', content);
      const header = Buffer.from(encryption!);
      header[12] ^= 1;

      await expect(readAll('blob', header)).rejects.toThrow(BlobIntegrityError);
      // another blob's header does not open it either
      const { encryption: other } = await write('other', content);
      await expect(readAll('blob', other)).rejects.toThrow(BlobIntegrityError);
    });
  });

  describe('head, list and deleteMany', () => {
    it('should report and delete the stored blobs', async () => {
      await write('a/one', randomBytes(10));
      const size = (await inner.head('a/one'))!.size;

      await expect(sut.head('a/one')).resolves.toEqual({ size });
      await expect(Array.fromAsync(sut.list('a/'))).resolves.toEqual([{ key: 'a/one', size }]);
      await expect(sut.deleteMany(['a/one'])).resolves.toEqual({ failed: [] });
      await expect(sut.head('a/one')).resolves.toBeNull();
    });
  });
});
