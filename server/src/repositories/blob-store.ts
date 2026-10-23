import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';

/**
 * Storage-agnostic access to file contents ("blobs") addressed by an opaque key.
 *
 * Implementations must only rely on guarantees that every supported backend documents (see the object storage
 * design notes): a key is written once and never overwritten, a successful write may not be immediately readable,
 * and a missing key on read does not prove that the blob is gone.
 */
export interface BlobStore {
  readonly limits: BlobStoreLimits;

  /** Write a new blob. Fails if the key already exists. Size and SHA-1 are computed while streaming. */
  put(key: string, body: NodeJS.ReadableStream, options?: BlobPutOptions): Promise<BlobPutResult>;

  /**
   * Read a blob, optionally a byte range of it. With `expect`, the stream fails (instead of ending normally) when the
   * bytes read do not match the recorded size or checksum.
   */
  get(key: string, options?: BlobGetOptions): Promise<NodeJS.ReadableStream>;

  /** `null` only means the blob was not found by this request; it does not prove the blob does not exist. */
  head(key: string): Promise<BlobStat | null>;

  /** Delete blobs. A key that is already gone counts as deleted. */
  deleteMany(keys: string[]): Promise<BlobDeleteResult>;

  /** List blobs below a prefix, in no particular order. Not for hot paths. */
  list(prefix?: string): AsyncIterable<BlobListEntry>;

  /** Where a blob lives on the local filesystem, for stores that keep blobs there. Does not check that it exists. */
  getLocalPath?(key: string): string;

  /**
   * Start writing a blob in parts, over several requests and possibly by several processes: the returned upload must be
   * kept by the caller and passed back. Every part but the last has `partSize` bytes. An upload may be gone at any time
   * (services do not promise to keep unfinished uploads), which `BlobUploadNotFoundError` reports: when a part is
   * written, or, for a store that does not track uploads (`limits.tracksUploads`), when it is completed.
   */
  createUpload(key: string, options: BlobUploadOptions): Promise<BlobUpload>;

  /** Write part `number` (from 1) of an upload; writing a part again replaces it. The last part needs `last`. */
  uploadPart(key: string, upload: BlobUpload, part: BlobUploadPart): Promise<UploadedPart>;

  /** Turn the parts, all of them in order, into the blob, which fails if the key exists already */
  completeUpload(key: string, upload: BlobUpload, parts: UploadedPart[]): Promise<void>;

  /** Drop an unfinished upload and its parts; an upload that is gone counts as dropped */
  abortUpload(key: string, upload: BlobUpload): Promise<void>;
}

export interface BlobUploadOptions {
  /** Size of every part but the last; at least `limits.minPartSize` */
  partSize: number;
}

/** An unfinished upload, as the caller keeps it between requests */
export interface BlobUpload {
  uploadId: string;
  partSize: number;
  /** For an encrypted blob, the header that reading it will need, and that encrypting its parts needs */
  encryption?: Buffer;
}

export interface BlobUploadPart {
  number: number;
  data: Buffer;
  /** Marks the last part, with the size and SHA-1 of the whole content, which an encrypted blob describes itself with */
  last?: { size: number; sha1: Buffer; manifest?: Record<string, unknown> };
}

export interface UploadedPart {
  number: number;
  etag: string;
  /** Bytes stored for the part, which for an encrypted blob are more than the content */
  size: number;
}

export interface BlobStoreLimits {
  maxDeleteBatch: number;
  minPartSize: number;
  maxParts: number;
  presign: boolean;
  /**
   * Whether the service keeps uploads in parts as things of their own (S3: multipart uploads), so that a part of an
   * upload it no longer knows is rejected, and an aborted upload is gone at once. Without (Azure: blocks staged under the
   * blob's name), an unknown upload looks like a new one, aborting leaves its parts to the service, which discards them
   * by itself (Azure: a week after the last one), and an upload that is gone is only reported when it is completed.
   */
  tracksUploads: boolean;
}

export interface BlobPutOptions {
  contentType?: string;
  sizeHint?: number;
  /** Describes the blob inside an encrypted blob, so that it can be recovered without the database */
  manifest?: Record<string, unknown>;
}

export interface BlobPutResult {
  /** Size and SHA-1 of the content, which for an encrypted blob is the plaintext */
  size: number;
  sha1: Buffer;
  /** For an encrypted blob, what reading it needs: to be recorded with the blob */
  encryption?: Buffer;
}

/** Inclusive byte range, like an HTTP `Range` header. `end` defaults to the last byte. */
export interface BlobRange {
  start: number;
  end?: number;
}

export interface BlobExpectation {
  /** Size of the whole blob as recorded when it was written. */
  size: number;
  /** SHA-1 of the whole blob; only checked when the whole blob is read. */
  sha1?: Buffer;
}

export interface BlobGetOptions {
  range?: BlobRange;
  expect?: BlobExpectation;
  /** What was recorded when an encrypted blob was written */
  encryption?: Buffer;
}

export interface BlobStat {
  size: number;
}

export interface BlobDeleteResult {
  failed: string[];
}

export interface BlobListEntry {
  key: string;
  size: number;
  /** When the blob was written, which tells a blob still being recorded from one that nothing records */
  lastModified: Date;
}

export class BlobNotFoundError extends Error {
  constructor(public readonly key: string) {
    super(`Blob not found: ${key}`);
    this.name = 'BlobNotFoundError';
  }
}

export class BlobExistsError extends Error {
  constructor(public readonly key: string) {
    super(`Blob already exists: ${key}`);
    this.name = 'BlobExistsError';
  }
}

export class BlobUploadNotFoundError extends Error {
  constructor(
    public readonly key: string,
    public readonly uploadId: string,
  ) {
    super(`Upload ${uploadId} of blob ${key} no longer exists`);
    this.name = 'BlobUploadNotFoundError';
  }
}

export class BlobRangeError extends Error {
  constructor(
    public readonly key: string,
    public readonly range: BlobRange,
    public readonly size: number,
  ) {
    super(`Range ${range.start}-${range.end ?? ''} is not satisfiable for blob ${key} of size ${size}`);
    this.name = 'BlobRangeError';
  }
}

export class BlobIntegrityError extends Error {
  constructor(
    public readonly key: string,
    reason: string,
  ) {
    super(`Blob ${key} failed integrity check: ${reason}`);
    this.name = 'BlobIntegrityError';
  }
}

/**
 * Keys are relative, slash-separated and normalized. New keys are random UUIDs, but legacy local files can have any
 * file name (including backslashes, which are ordinary characters on Linux, or very long paths), so only structurally
 * unsafe keys are rejected. Limits of a particular backend, such as a maximum key length, are checked by its driver.
 */
export const assertValidBlobKey = (key: string) => {
  if (!isValidBlobPath(key)) {
    throw new Error(`Invalid blob key: ${JSON.stringify(key)}`);
  }
};

export const assertValidBlobPrefix = (prefix: string) => {
  if (prefix === '') {
    return;
  }

  if (!isValidBlobPath(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix)) {
    throw new Error(`Invalid blob prefix: ${JSON.stringify(prefix)}`);
  }
};

const isValidBlobPath = (value: string) => {
  if (value.length === 0 || value.startsWith('/') || value.includes('\0')) {
    return false;
  }

  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
};

/** Resolve a byte range against a known size, clamping `end` to the last byte like HTTP does. */
export const resolveBlobRange = (key: string, range: BlobRange, size: number) => {
  const last = size - 1;
  const end = range.end === undefined ? last : Math.min(range.end, last);
  if (!Number.isSafeInteger(range.start) || range.start < 0 || range.start > last || end < range.start) {
    throw new BlobRangeError(key, range, size);
  }

  return { start: range.start, end, length: end - range.start + 1 };
};

/**
 * Pass-through stream that fails at the end of the data when the number of bytes or the SHA-1 does not match.
 * Failing in `flush` means consumers see an error event instead of a normal end, so a truncated or corrupt read is
 * never mistaken for a complete one.
 */
export const createVerifyingStream = (key: string, expected: { length?: number; sha1?: Buffer }) => {
  const hash = expected.sha1 ? createHash('sha1') : undefined;
  let length = 0;

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      length += chunk.length;
      if (expected.length !== undefined && length > expected.length) {
        callback(new BlobIntegrityError(key, `expected ${expected.length} bytes but read more`));
        return;
      }

      hash?.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      if (expected.length !== undefined && length !== expected.length) {
        callback(new BlobIntegrityError(key, `expected ${expected.length} bytes but read ${length}`));
        return;
      }

      if (hash && expected.sha1 && !hash.digest().equals(expected.sha1)) {
        callback(new BlobIntegrityError(key, 'checksum mismatch'));
        return;
      }

      callback();
    },
  });
};
