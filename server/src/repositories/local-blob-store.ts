import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Transform, pipeline as pipelineCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  BlobDeleteResult,
  BlobExistsError,
  BlobGetOptions,
  BlobIntegrityError,
  BlobListEntry,
  BlobNotFoundError,
  BlobPutResult,
  BlobStat,
  BlobStore,
  BlobStoreLimits,
  assertValidBlobKey,
  assertValidBlobPrefix,
  createVerifyingStream,
  resolveBlobRange,
} from 'src/repositories/blob-store.js';

/** Suffix of in-progress writes; such files are never visible as blobs. */
export const LOCAL_BLOB_TEMP_SUFFIX = '.immich-tmp';

const NOT_FOUND_CODES = ['ENOENT', 'ENOTDIR'];
// Filesystems that cannot create hard links (e.g. some network or FUSE mounts)
const NO_HARD_LINK_CODES = ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'];

const hasErrorCode = (error: unknown, codes: string[]) =>
  codes.includes((error as NodeJS.ErrnoException | undefined)?.code ?? '');

/** Blob store backed by a directory on the local filesystem; a key is a path relative to the root. */
export class LocalBlobStore implements BlobStore {
  readonly limits: BlobStoreLimits = {
    maxDeleteBatch: 1000,
    minPartSize: 0,
    maxParts: Infinity,
    presign: false,
  };

  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async put(key: string, body: NodeJS.ReadableStream): Promise<BlobPutResult> {
    const target = this.toPath(key);
    await fs.mkdir(dirname(target), { recursive: true });

    // Write to a temporary file first so a failed or partial write never shows up under the key
    const temp = `${target}.${randomUUID()}${LOCAL_BLOB_TEMP_SUFFIX}`;
    const hash = createHash('sha1');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    try {
      await pipeline(body, meter, createWriteStream(temp, { flags: 'wx' }));
      await this.publish(key, temp, target);
    } finally {
      await fs.rm(temp, { force: true });
    }

    return { size, sha1: hash.digest() };
  }

  async get(key: string, options: BlobGetOptions = {}): Promise<NodeJS.ReadableStream> {
    const path = this.toPath(key);
    const { size } = await this.statOrThrow(key, path);
    const { range, expect } = options;

    if (expect && size !== expect.size) {
      throw new BlobIntegrityError(key, `expected ${expect.size} bytes but blob has ${size}`);
    }

    if (range) {
      const { start, end, length } = resolveBlobRange(key, range, size);
      const stream = createReadStream(path, { start, end });
      return expect ? this.verify(stream, createVerifyingStream(key, { length })) : stream;
    }

    const stream = createReadStream(path);
    return expect
      ? this.verify(stream, createVerifyingStream(key, { length: expect.size, sha1: expect.sha1 }))
      : stream;
  }

  async head(key: string): Promise<BlobStat | null> {
    const stat = await this.stat(this.toPath(key));
    return stat ? { size: stat.size } : null;
  }

  async deleteMany(keys: string[]): Promise<BlobDeleteResult> {
    const paths = keys.map((key) => ({ key, path: this.toPath(key) }));
    const failed: string[] = [];

    for (const { key, path } of paths) {
      try {
        await fs.unlink(path);
      } catch (error) {
        if (!hasErrorCode(error, NOT_FOUND_CODES)) {
          failed.push(key);
        }
      }
    }

    return { failed };
  }

  getLocalPath(key: string): string {
    return this.toPath(key);
  }

  async *list(prefix = ''): AsyncIterable<BlobListEntry> {
    assertValidBlobPrefix(prefix);
    // Start from the deepest directory that the prefix fully names, then filter on the whole prefix
    const lastSlash = prefix.lastIndexOf('/');
    yield* this.walk(lastSlash === -1 ? '' : prefix.slice(0, lastSlash), prefix);
  }

  private async *walk(directoryKey: string, prefix: string): AsyncIterable<BlobListEntry> {
    const directory = directoryKey ? this.toPath(directoryKey) : this.root;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (hasErrorCode(error, NOT_FOUND_CODES)) {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      const key = directoryKey ? `${directoryKey}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (`${key}/`.startsWith(prefix) || prefix.startsWith(`${key}/`)) {
          yield* this.walk(key, prefix);
        }
        continue;
      }

      if (!entry.isFile() || entry.name.endsWith(LOCAL_BLOB_TEMP_SUFFIX) || !key.startsWith(prefix)) {
        continue;
      }

      const stat = await this.stat(join(directory, entry.name));
      if (stat) {
        yield { key, size: stat.size };
      }
    }
  }

  private toPath(key: string) {
    assertValidBlobKey(key);
    return join(this.root, ...key.split('/'));
  }

  private async publish(key: string, temp: string, target: string) {
    try {
      // A hard link fails if the target exists, which gives create-only semantics without a race
      await fs.link(temp, target);
    } catch (error) {
      if (hasErrorCode(error, ['EEXIST'])) {
        throw new BlobExistsError(key);
      }

      if (!hasErrorCode(error, NO_HARD_LINK_CODES)) {
        throw error;
      }

      // Keys are unique by construction, so checking before the rename is enough here
      if (await this.stat(target)) {
        throw new BlobExistsError(key);
      }

      await fs.rename(temp, target);
    }
  }

  private async stat(path: string) {
    try {
      const stat = await fs.stat(path);
      return stat.isFile() ? stat : null;
    } catch (error) {
      if (hasErrorCode(error, NOT_FOUND_CODES)) {
        return null;
      }
      throw error;
    }
  }

  private async statOrThrow(key: string, path: string) {
    const stat = await this.stat(path);
    if (!stat) {
      throw new BlobNotFoundError(key);
    }
    return stat;
  }

  private verify(source: NodeJS.ReadableStream, verifier: Transform) {
    // pipeline destroys the verifier with the source's error, so read errors are not swallowed
    pipelineCallback(source, verifier, () => {});
    return verifier;
  }
}
