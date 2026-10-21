import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import {
  BlobDeleteResult,
  BlobGetOptions,
  BlobIntegrityError,
  BlobListEntry,
  BlobPutOptions,
  BlobPutResult,
  BlobStat,
  BlobStore,
  BlobStoreLimits,
  createVerifyingStream,
  resolveBlobRange,
} from 'src/repositories/blob-store.js';
import { KeyProvider, MASTER_KEY_ID_LENGTH } from 'src/repositories/key-provider.js';

/**
 * Application-layer encryption of blobs, in a format that can be read from any position (see the encryption design
 * notes):
 *
 *   blob    = chunk_0 || ... || chunk_n-1 || trailer || length of trailer (4 bytes, big endian)
 *   chunk_i = AEAD(file key, nonce = prefix (7) || i (4, big endian) || last chunk (1), aad = header || blob key)
 *   trailer = header || AEAD(file key, nonce = prefix || 0 || 2, aad = header) of a JSON manifest
 *
 * The header is also recorded in the database; reads use that copy, the trailer makes a blob recoverable from the
 * storage and the master key alone. Every file has its own random key, wrapped with the master key (AES key wrap).
 * The chunk index in the nonce detects reordered chunks, the last chunk flag truncation, and the blob key in the
 * associated data a blob moved to another key.
 */
export enum EncryptionSuite {
  Aes256Gcm = 1,
  ChaCha20Poly1305 = 2,
}

export const ENCRYPTION_CHUNK_SIZE_LOG = 16;
const TAG_LENGTH = 16;
const MAGIC = Buffer.from('IMMENC01');
const FORMAT_VERSION = 1;
const NONCE_PREFIX_LENGTH = 7;
const FILE_KEY_LENGTH = 32;
const WRAPPED_KEY_LENGTH = FILE_KEY_LENGTH + 8;
const KEY_WRAP_IV = Buffer.from('A6A6A6A6A6A6A6A6', 'hex');
export const ENCRYPTION_HEADER_LENGTH =
  MAGIC.length + 3 + NONCE_PREFIX_LENGTH + MASTER_KEY_ID_LENGTH + WRAPPED_KEY_LENGTH;

const enum NonceFlag {
  Chunk = 0,
  LastChunk = 1,
  Manifest = 2,
}

export interface EncryptionHeader {
  suite: EncryptionSuite;
  chunkSizeLog: number;
  noncePrefix: Buffer;
  masterKeyId: Buffer;
  wrappedKey: Buffer;
}

export const encodeEncryptionHeader = ({
  suite,
  chunkSizeLog,
  noncePrefix,
  masterKeyId,
  wrappedKey,
}: EncryptionHeader) =>
  Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION, suite, chunkSizeLog]), noncePrefix, masterKeyId, wrappedKey]);

export const decodeEncryptionHeader = (header: Buffer): EncryptionHeader => {
  const isValid =
    header.length === ENCRYPTION_HEADER_LENGTH &&
    header.subarray(0, MAGIC.length).equals(MAGIC) &&
    header[MAGIC.length] === FORMAT_VERSION &&
    Object.values(EncryptionSuite).includes(header[MAGIC.length + 1]) &&
    header[MAGIC.length + 2] >= 12 &&
    header[MAGIC.length + 2] <= 24;
  if (!isValid) {
    throw new Error('Not a supported encryption header');
  }

  let offset = MAGIC.length + 1;
  const take = (length: number) => header.subarray(offset, (offset += length));
  const [suite, chunkSizeLog] = take(2);
  return {
    suite,
    chunkSizeLog,
    noncePrefix: take(NONCE_PREFIX_LENGTH),
    masterKeyId: take(MASTER_KEY_ID_LENGTH),
    wrappedKey: take(WRAPPED_KEY_LENGTH),
  };
};

export const wrapKey = (masterKey: Buffer, key: Buffer) => {
  const cipher = createCipheriv('id-aes256-wrap', masterKey, KEY_WRAP_IV);
  return Buffer.concat([cipher.update(key), cipher.final()]);
};

export const unwrapKey = (masterKey: Buffer, wrappedKey: Buffer) => {
  try {
    const decipher = createDecipheriv('id-aes256-wrap', masterKey, KEY_WRAP_IV);
    return Buffer.concat([decipher.update(wrappedKey), decipher.final()]);
  } catch {
    throw new Error('Unable to unwrap the file key with the master key');
  }
};

const createAeadCipher = (suite: EncryptionSuite, key: Buffer, iv: Buffer) =>
  suite === EncryptionSuite.Aes256Gcm
    ? createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LENGTH })
    : createCipheriv('chacha20-poly1305', key, iv, { authTagLength: TAG_LENGTH });

const createAeadDecipher = (suite: EncryptionSuite, key: Buffer, iv: Buffer) =>
  suite === EncryptionSuite.Aes256Gcm
    ? createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LENGTH })
    : createDecipheriv('chacha20-poly1305', key, iv, { authTagLength: TAG_LENGTH });

const nonce = (prefix: Buffer, index: number, flag: NonceFlag) => {
  const value = Buffer.alloc(12);
  prefix.copy(value, 0);
  value.writeUInt32BE(index, NONCE_PREFIX_LENGTH);
  value[11] = flag;
  return value;
};

const seal = (suite: EncryptionSuite, key: Buffer, iv: Buffer, aad: Buffer, plaintext: Buffer) => {
  const cipher = createAeadCipher(suite, key, iv);
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
};

export const open = (suite: EncryptionSuite, key: Buffer, iv: Buffer, aad: Buffer, sealed: Buffer) => {
  if (sealed.length < TAG_LENGTH) {
    throw new Error('sealed data is shorter than a tag');
  }
  const decipher = createAeadDecipher(suite, key, iv);
  const ciphertext = sealed.subarray(0, -TAG_LENGTH);
  decipher.setAAD(aad, { plaintextLength: ciphertext.length });
  decipher.setAuthTag(sealed.subarray(-TAG_LENGTH));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
};

export const chunkAad = (header: Buffer, key: string) => Buffer.concat([header, Buffer.from(key, 'utf8')]);

/** Number of chunks of a plaintext; an empty plaintext still has one (empty, last) chunk */
export const chunkCount = (size: number, chunkSize: number) => Math.max(1, Math.ceil(size / chunkSize));

/** Bytes of the chunks of a plaintext, which is where the trailer starts */
export const encryptedDataLength = (size: number, chunkSize: number) => size + chunkCount(size, chunkSize) * TAG_LENGTH;

export interface EncryptedBlobStoreOptions {
  suite?: EncryptionSuite;
}

/** Encrypts blobs before they reach another store; reads need the header and plaintext size that writes returned */
export class EncryptedBlobStore implements BlobStore {
  readonly limits: BlobStoreLimits;
  private readonly suite: EncryptionSuite;

  constructor(
    private readonly inner: BlobStore,
    private readonly keys: KeyProvider,
    options: EncryptedBlobStoreOptions = {},
  ) {
    this.limits = inner.limits;
    this.suite = options.suite ?? EncryptionSuite.Aes256Gcm;
  }

  async put(key: string, body: NodeJS.ReadableStream, options: BlobPutOptions = {}): Promise<BlobPutResult> {
    const fileKey = randomBytes(FILE_KEY_LENGTH);
    const masterKeyId = this.keys.currentKeyId;
    const header = encodeEncryptionHeader({
      suite: this.suite,
      chunkSizeLog: ENCRYPTION_CHUNK_SIZE_LOG,
      noncePrefix: randomBytes(NONCE_PREFIX_LENGTH),
      masterKeyId,
      wrappedKey: wrapKey(this.keys.getKey(masterKeyId), fileKey),
    });
    const { suite, noncePrefix } = decodeEncryptionHeader(header);
    const chunkSize = 2 ** ENCRYPTION_CHUNK_SIZE_LOG;
    const aad = chunkAad(header, key);
    const hash = createHash('sha1');
    let size = 0;

    async function* encrypt() {
      let rest: Buffer = Buffer.alloc(0);
      let index = 0;

      for await (const value of body as AsyncIterable<Buffer | string>) {
        const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
        hash.update(data);
        size += data.length;
        rest = rest.length === 0 ? data : Buffer.concat([rest, data]);

        // a chunk is only sealed once more data follows, since the last chunk is sealed differently
        while (rest.length > chunkSize) {
          yield seal(suite, fileKey, nonce(noncePrefix, index++, NonceFlag.Chunk), aad, rest.subarray(0, chunkSize));
          rest = rest.subarray(chunkSize);
        }
      }

      yield seal(suite, fileKey, nonce(noncePrefix, index, NonceFlag.LastChunk), aad, rest);

      const manifest = Buffer.from(
        JSON.stringify({ ...options.manifest, key, size, sha1: hash.copy().digest('hex') }),
        'utf8',
      );
      const trailer = Buffer.concat([
        header,
        seal(suite, fileKey, nonce(noncePrefix, 0, NonceFlag.Manifest), header, manifest),
      ]);
      const trailerLength = Buffer.alloc(4);
      trailerLength.writeUInt32BE(trailer.length);
      yield Buffer.concat([trailer, trailerLength]);
    }

    const sizeHint =
      options.sizeHint === undefined ? undefined : encryptedDataLength(options.sizeHint, chunkSize) + 4096;
    await this.inner.put(key, Readable.from(encrypt()), { sizeHint });
    return { size, sha1: hash.digest(), encryption: header };
  }

  async get(key: string, { range, expect, encryption }: BlobGetOptions = {}): Promise<NodeJS.ReadableStream> {
    if (!encryption || !expect) {
      throw new Error(`Reading the encrypted blob ${key} needs its recorded encryption header and size`);
    }

    const header = decodeEncryptionHeader(encryption);
    const fileKey = unwrapKey(this.keys.getKey(header.masterKeyId), header.wrappedKey);
    const chunkSize = 2 ** header.chunkSizeLog;
    const size = expect.size;
    const count = chunkCount(size, chunkSize);
    const dataLength = encryptedDataLength(size, chunkSize);

    // the plaintext range to send, and the chunks that hold it
    let start = 0;
    let end = size - 1;
    if (range) {
      ({ start, end } = resolveBlobRange(key, range, size));
    }
    const first = Math.floor(start / chunkSize);
    const last = size === 0 ? 0 : Math.floor(end / chunkSize);
    const cipherStart = first * (chunkSize + TAG_LENGTH);
    const cipherEnd = Math.min((last + 1) * (chunkSize + TAG_LENGTH), dataLength) - 1;

    const encrypted = await this.inner.get(key, { range: { start: cipherStart, end: cipherEnd } });
    const aad = chunkAad(encryption, key);
    let index = first;
    let pending: Buffer = Buffer.alloc(0);

    const cipherLength = (chunk: number) =>
      chunk < count - 1 ? chunkSize + TAG_LENGTH : size - (count - 1) * chunkSize + TAG_LENGTH;

    const decrypt = new Transform({
      transform(data: Buffer, _encoding, callback) {
        pending = pending.length === 0 ? data : Buffer.concat([pending, data]);
        const output: Buffer[] = [];
        try {
          while (index <= last && pending.length >= cipherLength(index)) {
            const length = cipherLength(index);
            const plaintext = open(
              header.suite,
              fileKey,
              nonce(header.noncePrefix, index, index === count - 1 ? NonceFlag.LastChunk : NonceFlag.Chunk),
              aad,
              pending.subarray(0, length),
            );
            pending = pending.subarray(length);

            const offset = index * chunkSize;
            const from = Math.max(start - offset, 0);
            const to = Math.min(end - offset + 1, plaintext.length);
            if (to > from) {
              output.push(plaintext.subarray(from, to));
            }
            index++;
          }
        } catch {
          callback(new BlobIntegrityError(key, `chunk ${index} failed authentication`));
          return;
        }
        callback(null, Buffer.concat(output));
      },
      flush(callback) {
        // a missing chunk is an error, never the end of the blob
        callback(index > last ? null : new BlobIntegrityError(key, `the blob ends before chunk ${index}`));
      },
    });
    encrypted.on('error', (error) => decrypt.destroy(error));

    const plaintext = encrypted.pipe(decrypt);
    const sha1 = range ? undefined : expect.sha1;
    if (!sha1) {
      return plaintext;
    }

    const verifier = createVerifyingStream(key, { length: size, sha1 });
    plaintext.on('error', (error) => verifier.destroy(error));
    return plaintext.pipe(verifier);
  }

  /** The size of the stored, encrypted blob */
  head(key: string): Promise<BlobStat | null> {
    return this.inner.head(key);
  }

  deleteMany(keys: string[]): Promise<BlobDeleteResult> {
    return this.inner.deleteMany(keys);
  }

  /** Stored blobs with their encrypted size */
  list(prefix?: string): AsyncIterable<BlobListEntry> {
    return this.inner.list(prefix);
  }
}
