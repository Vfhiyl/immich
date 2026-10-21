import { createReadStream, createWriteStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import {
  BlobDeleteResult,
  BlobGetOptions,
  BlobListEntry,
  BlobPutResult,
  BlobRangeError,
  BlobStat,
  BlobStore,
  resolveBlobRange,
} from 'src/repositories/blob-store.js';
import {
  ENCRYPTION_HEADER_LENGTH,
  EncryptedBlobStore,
  EncryptionSuite,
  TRAILER_LENGTH_SIZE,
  decodeEncryptionHeader,
  encryptedDataLength,
  openTrailer,
} from 'src/repositories/encrypted-blob-store.js';
import { MasterKeys, writeNewMasterKey } from 'src/repositories/key-provider.js';

/**
 * The `immich-encryption` command: master keys and encrypted files, with nothing but the files themselves. It needs no
 * database, no Redis and no running Immich, so that keys can be made before the first start and files recovered after
 * a disaster.
 */
export interface ToolOutput {
  log: (message: string) => void;
  error: (message: string) => void;
}

export const ENCRYPTION_TOOL_USAGE = `Usage: immich-encryption <command>

Commands:
  generate-key <file>           Create a master key file for encrypted storage backends
  generate-key --rotate <file>  Add a new key to a master key file; it encrypts new files, the older keys stay for
                                the files they encrypted
  inspect <object>              Show how a stored object is encrypted (no key needed)
  decrypt --keys <file> <object> <output>
                                Decrypt a stored object, e.g. one copied from the bucket, with nothing but the master
                                key file; the content is checked against its size, SHA-1 and authentication tags`;

/** Largest trailer accepted: a header and a small manifest, so that a damaged length cannot ask for a huge read */
const MAX_TRAILER_LENGTH = 1024 * 1024;

/** A single local file as a read-only store, so that it is decrypted exactly like blobs on a backend */
class FileAsBlobStore implements BlobStore {
  readonly limits = { maxDeleteBatch: 0, minPartSize: 0, maxParts: 0, presign: false };

  constructor(
    private path: string,
    private size: number,
  ) {}

  get(key: string, { range }: BlobGetOptions = {}): Promise<NodeJS.ReadableStream> {
    const { start, end } = range ? resolveBlobRange(key, range, this.size) : { start: 0, end: this.size - 1 };
    if (range?.end !== undefined && range.end > end) {
      throw new BlobRangeError(key, range, this.size);
    }
    return Promise.resolve(createReadStream(this.path, { start, end }));
  }

  put(): Promise<BlobPutResult> {
    throw new Error('Read only');
  }

  head(): Promise<BlobStat | null> {
    return Promise.resolve({ size: this.size });
  }

  deleteMany(): Promise<BlobDeleteResult> {
    throw new Error('Read only');
  }

  list(): AsyncIterable<BlobListEntry> {
    throw new Error('Read only');
  }
}

/** The trailer at the end of a stored object, and where its encrypted data ends */
const readTrailer = async (path: string) => {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const lengthBytes = Buffer.alloc(TRAILER_LENGTH_SIZE);
    if (size < TRAILER_LENGTH_SIZE) {
      throw new Error(`${path} is too short to be an encrypted object`);
    }
    await file.read(lengthBytes, 0, TRAILER_LENGTH_SIZE, size - TRAILER_LENGTH_SIZE);
    const length = lengthBytes.readUInt32BE();
    if (length < ENCRYPTION_HEADER_LENGTH || length > MAX_TRAILER_LENGTH || length > size - TRAILER_LENGTH_SIZE) {
      throw new Error(`${path} does not end with the trailer of an encrypted object`);
    }

    const trailer = Buffer.alloc(length);
    const dataLength = size - TRAILER_LENGTH_SIZE - length;
    await file.read(trailer, 0, length, dataLength);
    return { trailer, dataLength };
  } finally {
    await file.close();
  }
};

const inspect = async (args: string[], output: ToolOutput) => {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  if (positionals.length !== 1) {
    output.error('inspect needs the path of a stored object');
    return 2;
  }

  const { trailer, dataLength } = await readTrailer(positionals[0]);
  const header = decodeEncryptionHeader(trailer.subarray(0, ENCRYPTION_HEADER_LENGTH));
  output.log(`Format:          IMMENC01, version 1`);
  output.log(`Algorithm:       ${header.suite === EncryptionSuite.Aes256Gcm ? 'AES-256-GCM' : 'ChaCha20-Poly1305'}`);
  output.log(`Chunk size:      ${2 ** header.chunkSizeLog} bytes`);
  output.log(`Master key:      ${header.masterKeyId.toString('hex')}`);
  output.log(`Encrypted data:  ${dataLength} bytes`);
  return 0;
};

const decrypt = async (args: string[], output: ToolOutput) => {
  const { values, positionals } = parseArgs({ args, options: { keys: { type: 'string' } }, allowPositionals: true });
  const [source, target] = positionals;
  if (!values.keys || positionals.length !== 2) {
    output.error('decrypt needs --keys <master key file>, the path of a stored object and the path to write it to');
    return 2;
  }

  const keys = MasterKeys.fromFile(values.keys);
  const { trailer, dataLength } = await readTrailer(source);
  const { masterKeyId } = decodeEncryptionHeader(trailer.subarray(0, ENCRYPTION_HEADER_LENGTH));
  if (!keys.hasKey(masterKeyId)) {
    output.error(
      `${source} was encrypted with master key ${masterKeyId.toString('hex')}, which is not in ${values.keys}`,
    );
    return 1;
  }

  const { header, manifest } = openTrailer(trailer, keys);
  const chunkSize = 2 ** decodeEncryptionHeader(header).chunkSizeLog;
  if (encryptedDataLength(manifest.size, chunkSize) !== dataLength) {
    throw new Error(
      `${source} holds ${dataLength} bytes of encrypted data, its manifest describes ${manifest.size} bytes`,
    );
  }

  // the trailer is past the encrypted data, so the store never reads it as data
  const store = new EncryptedBlobStore(new FileAsBlobStore(source, dataLength), keys);
  const plaintext = await store.get(manifest.key, {
    encryption: header,
    expect: { size: manifest.size, sha1: Buffer.from(manifest.sha1, 'hex') },
  });
  try {
    await pipeline(plaintext, createWriteStream(target, { flags: 'wx' }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      await rm(target, { force: true });
    }
    throw error;
  }

  const { key, size, sha1, ...described } = manifest;
  output.log(`Decrypted ${source} to ${target}: ${size} bytes, SHA-1 ${sha1}, stored as ${key}`);
  for (const [name, value] of Object.entries(described)) {
    output.log(`  ${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }
  return 0;
};

const generateKey = async (args: string[], output: ToolOutput) => {
  const { values, positionals } = parseArgs({ args, options: { rotate: { type: 'boolean' } }, allowPositionals: true });
  const [path] = positionals;
  if (positionals.length !== 1 || !isAbsolute(path)) {
    output.error('generate-key needs the absolute path of the master key file');
    return 2;
  }

  const rotate = values.rotate ?? false;
  let id: string;
  try {
    ({ id } = await writeNewMasterKey(path, { rotate }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST' && !rotate) {
      output.error(`${path} already exists; replacing it would lose its keys. Use --rotate to add a new key to it.`);
      return 1;
    }
    throw error;
  }
  output.log(`${rotate ? 'Added' : 'Wrote'} master key ${id} to ${path}`);
  output.log(
    rotate
      ? 'New files are encrypted with it once Immich restarts. Keep the older keys: the files they encrypted need them.'
      : 'Set encryption.masterKeyFile to this path in the storage backend configuration.',
  );
  output.log(
    'Keep a copy of this file apart from the storage and the database: encrypted files cannot be read without it.',
  );
  return 0;
};

/** Run the tool with its arguments, resolving with the exit code */
export const runEncryptionTool = async (args: string[], output: ToolOutput): Promise<number> => {
  const [command, ...rest] = args;
  try {
    switch (command) {
      case 'generate-key': {
        return await generateKey(rest, output);
      }

      case 'inspect': {
        return await inspect(rest, output);
      }

      case 'decrypt': {
        return await decrypt(rest, output);
      }

      default: {
        output.error(ENCRYPTION_TOOL_USAGE);
        return 2;
      }
    }
  } catch (error) {
    output.error(`${command} failed: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
};
