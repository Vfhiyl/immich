import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ClientConfig,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import {
  BlobDeleteResult,
  BlobGetOptions,
  BlobIntegrityError,
  BlobListEntry,
  BlobNotFoundError,
  BlobPutOptions,
  BlobPutResult,
  BlobRange,
  BlobRangeError,
  BlobStat,
  BlobStore,
  BlobStoreLimits,
  BlobUpload,
  BlobUploadNotFoundError,
  BlobUploadOptions,
  BlobUploadPart,
  UploadedPart,
  assertValidBlobKey,
  assertValidBlobPrefix,
  createVerifyingStream,
} from 'src/repositories/blob-store.js';

/** Equal parts of 16 MiB: at least 5 MiB and a multiple of 256 KiB, as every supported service accepts */
export const S3_PART_SIZE = 16 * 1024 * 1024;
const PART_SIZE_STEP = 256 * 1024;
const MAX_PARTS = 10_000;
/** Longest key the S3 protocol accepts, including the key prefix */
const MAX_KEY_BYTES = 1024;

export interface S3BackendOptions {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  addressing: 'virtual-host' | 'path';
  credentials:
    { type: 'static'; accessKeyId: string; secretAccessKeyFile: string } | { type: 'chain'; profile?: string };
}

export const createS3Client = (options: S3BackendOptions, overrides: Partial<S3ClientConfig> = {}) => {
  const { credentials } = options;
  return new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    forcePathStyle: options.addressing === 'path',
    ...(credentials.type === 'static'
      ? {
          credentials: {
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: readFileSync(credentials.secretAccessKeyFile, 'utf8').trim(),
          },
        }
      : { profile: credentials.profile }),
    // checksums are computed by Immich; services differ in which SDK checksums they accept
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    // exponential backoff, including for 503 Slow Down
    retryMode: 'standard',
    maxAttempts: 5,
    // an inactivity timeout, which also suits long transfers; the SDK's requestTimeout only warns by default
    requestHandler: { connectionTimeout: 10_000, socketTimeout: 120_000 },
    ...overrides,
  });
};

const errorName = (error: unknown) => (error as { name?: string } | undefined)?.name ?? '';
const statusCode = (error: unknown) =>
  (error as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata?.httpStatusCode;
const isNotFound = (error: unknown) =>
  ['NoSuchKey', 'NotFound'].includes(errorName(error) ?? '') || statusCode(error) === 404;

/**
 * Blob store on any service that speaks the S3 protocol. It only relies on the minimum common contract of the
 * supported services (see the object storage design notes): no conditional writes (keys are unique), no checksums
 * of the service (Immich computes size and SHA-1), equal-sized multipart parts, and every read is verified.
 */
export class S3BlobStore implements BlobStore {
  readonly limits: BlobStoreLimits = {
    maxDeleteBatch: 1000,
    minPartSize: 5 * 1024 * 1024,
    maxParts: MAX_PARTS,
    presign: false,
  };

  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    private readonly prefix = '',
  ) {}

  async put(key: string, body: NodeJS.ReadableStream, options: BlobPutOptions = {}): Promise<BlobPutResult> {
    const objectKey = this.toObjectKey(key);
    const partSize = getPartSize(options.sizeHint);
    const hash = createHash('sha1');
    let size = 0;

    const parts = readParts(body, partSize, (chunk) => {
      size += chunk.length;
      hash.update(chunk);
    });

    const first = await parts.next();
    const second = first.done || first.value.length < partSize ? undefined : await parts.next();
    if (!second || second.done) {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
          Body: first.done ? Buffer.alloc(0) : (first.value as Buffer),
          ContentType: 'application/octet-stream',
        }),
      );
      return { size, sha1: hash.digest() };
    }

    await this.putMultipart(objectKey, partSize, first.value as Buffer, second.value as Buffer, parts);
    const sha1 = hash.digest();
    return { size, sha1 };
  }

  async get(key: string, { range, expect }: BlobGetOptions = {}): Promise<NodeJS.ReadableStream> {
    const objectKey = this.toObjectKey(key);
    if (range) {
      assertValidRange(key, range, expect?.size);
    }

    let response;
    try {
      response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
          Range: range ? `bytes=${range.start}-${range.end ?? ''}` : undefined,
        }),
      );
    } catch (error) {
      if (isNotFound(error)) {
        throw new BlobNotFoundError(key);
      }
      if (range && (errorName(error) === 'InvalidRange' || statusCode(error) === 416)) {
        throw new BlobRangeError(key, range, expect?.size ?? -1);
      }
      throw error;
    }

    const stream = response.Body as Readable;
    try {
      const { total, length } = this.getResponseSize(key, range, response.ContentRange, response.ContentLength);
      if (expect && total !== expect.size) {
        throw new BlobIntegrityError(key, `expected ${expect.size} bytes but blob has ${total}`);
      }

      const verifier = createVerifyingStream(key, { length, sha1: range ? undefined : expect?.sha1 });
      stream.on('error', (error) => verifier.destroy(error));
      return stream.pipe(verifier);
    } catch (error) {
      stream.destroy();
      throw error;
    }
  }

  async head(key: string): Promise<BlobStat | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.toObjectKey(key) }),
      );
      return { size: response.ContentLength ?? 0 };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async deleteMany(keys: string[]): Promise<BlobDeleteResult> {
    const objectKeys = new Map(keys.map((key) => [this.toObjectKey(key), key]));
    const failed: string[] = [];

    const all = objectKeys.keys().toArray();
    for (let index = 0; index < all.length; index += this.limits.maxDeleteBatch) {
      const batch = all.slice(index, index + this.limits.maxDeleteBatch);
      const command = new DeleteObjectsCommand({
        Bucket: this.bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      });
      addContentMd5(command);
      const response = await this.client.send(command);
      for (const error of response.Errors ?? []) {
        // a blob that is already gone counts as deleted
        if (error.Code !== 'NoSuchKey' && error.Key) {
          failed.push(objectKeys.get(error.Key) ?? error.Key);
        }
      }
    }

    return { failed };
  }

  async *list(prefix = ''): AsyncIterable<BlobListEntry> {
    assertValidBlobPrefix(prefix);
    let continuationToken: string | undefined;
    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.prefix + prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const object of response.Contents ?? []) {
        if (object.Key?.startsWith(this.prefix)) {
          yield {
            key: object.Key.slice(this.prefix.length),
            size: object.Size ?? 0,
            lastModified: object.LastModified ?? new Date(0),
          };
        }
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  async createUpload(key: string, { partSize }: BlobUploadOptions): Promise<BlobUpload> {
    const objectKey = this.toObjectKey(key);
    if (partSize < this.limits.minPartSize) {
      throw new Error(`Parts of ${partSize} bytes are smaller than the ${this.limits.minPartSize} bytes S3 needs`);
    }

    const { UploadId: uploadId } = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: objectKey,
        ContentType: 'application/octet-stream',
      }),
    );
    if (!uploadId) {
      throw new Error(`No upload id returned for ${objectKey}`);
    }
    return { uploadId, partSize };
  }

  async uploadPart(key: string, upload: BlobUpload, { number, data }: BlobUploadPart): Promise<UploadedPart> {
    const objectKey = this.toObjectKey(key);
    if (number < 1 || number > MAX_PARTS) {
      throw new Error(`Part ${number} of ${objectKey} is not between 1 and ${MAX_PARTS}`);
    }

    try {
      const { ETag } = await this.client.send(
        new UploadPartCommand({
          Bucket: this.bucket,
          Key: objectKey,
          UploadId: upload.uploadId,
          PartNumber: number,
          Body: data,
          ContentLength: data.length,
        }),
      );
      if (!ETag) {
        throw new Error(`No ETag returned for part ${number} of ${objectKey}`);
      }
      return { number, etag: ETag, size: data.length };
    } catch (error) {
      throw this.toUploadError(key, upload, error);
    }
  }

  async completeUpload(key: string, upload: BlobUpload, parts: UploadedPart[]): Promise<void> {
    const objectKey = this.toObjectKey(key);
    const size = parts.reduce((total, part) => total + part.size, 0);
    try {
      await this.completeMultipart(
        objectKey,
        upload.uploadId,
        parts.map(({ number, etag }) => ({ PartNumber: number, ETag: etag })),
        size,
      );
    } catch (error) {
      throw this.toUploadError(key, upload, error);
    }
  }

  async abortUpload(key: string, upload: BlobUpload): Promise<void> {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: this.toObjectKey(key), UploadId: upload.uploadId }),
      );
    } catch (error) {
      if (!['NoSuchUpload', 'NotFound'].includes(errorName(error))) {
        throw error;
      }
    }
  }

  /** An upload the service no longer knows can only be started again */
  private toUploadError(key: string, upload: BlobUpload, error: unknown) {
    return ['NoSuchUpload', 'NotFound'].includes(errorName(error))
      ? new BlobUploadNotFoundError(key, upload.uploadId)
      : error;
  }

  private async putMultipart(
    objectKey: string,
    partSize: number,
    first: Buffer,
    second: Buffer,
    rest: AsyncGenerator<Buffer>,
  ) {
    const { UploadId: uploadId } = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: objectKey,
        ContentType: 'application/octet-stream',
      }),
    );
    if (!uploadId) {
      throw new Error(`No upload id returned for ${objectKey}`);
    }

    const parts: { ETag: string; PartNumber: number }[] = [];
    let total = 0;
    try {
      const uploadPart = async (body: Buffer) => {
        const partNumber = parts.length + 1;
        if (partNumber > MAX_PARTS) {
          throw new Error(`${objectKey} needs more than ${MAX_PARTS} parts of ${partSize} bytes`);
        }
        const { ETag } = await this.client.send(
          new UploadPartCommand({
            Bucket: this.bucket,
            Key: objectKey,
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: body,
            ContentLength: body.length,
          }),
        );
        if (!ETag) {
          throw new Error(`No ETag returned for part ${partNumber} of ${objectKey}`);
        }
        parts.push({ ETag, PartNumber: partNumber });
        total += body.length;
      };

      await uploadPart(first);
      await uploadPart(second);
      for await (const part of rest) {
        await uploadPart(part);
      }

      await this.completeMultipart(objectKey, uploadId, parts, total);
    } catch (error) {
      await this.client
        .send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: objectKey, UploadId: uploadId }))
        .catch(() => {});
      throw error;
    }
  }

  private async completeMultipart(
    objectKey: string,
    uploadId: string,
    parts: { ETag: string; PartNumber: number }[],
    size: number,
  ) {
    try {
      // the SDK parses the body, which can hold an error even with a 200 response
      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: objectKey,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts },
        }),
      );
    } catch (error) {
      // a retried request can find the upload already completed by an attempt that timed out
      if (errorName(error) === 'NoSuchUpload') {
        const stat = await this.head(objectKey.slice(this.prefix.length)).catch(() => null);
        if (stat?.size === size) {
          return;
        }
      }
      throw error;
    }
  }

  private getResponseSize(key: string, range: BlobRange | undefined, contentRange?: string, contentLength?: number) {
    if (!range) {
      return { total: contentLength ?? 0, length: contentLength ?? 0 };
    }

    // a service that ignores the range would send the whole blob as if it were the range
    const match = contentRange?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    if (!match || Number(match[1]) !== range.start) {
      throw new BlobIntegrityError(
        key,
        `unexpected content range ${contentRange} for ${range.start}-${range.end ?? ''}`,
      );
    }

    const [, start, end, total] = match.map(Number);
    return { total, length: end - start + 1 };
  }

  private toObjectKey(key: string) {
    assertValidBlobKey(key);
    const objectKey = this.prefix + key;
    if (Buffer.byteLength(objectKey) > MAX_KEY_BYTES) {
      throw new Error(`Blob key is too long for an S3 backend: ${JSON.stringify(key)}`);
    }
    return objectKey;
  }
}

/** Parts are as large as needed to stay within the part limit, in steps that every service accepts */
const getPartSize = (sizeHint?: number) => {
  if (!sizeHint || sizeHint <= S3_PART_SIZE * MAX_PARTS) {
    return S3_PART_SIZE;
  }
  return Math.ceil(sizeHint / MAX_PARTS / PART_SIZE_STEP) * PART_SIZE_STEP;
};

/** Split a stream into parts of exactly `partSize` bytes, except the last */
async function* readParts(body: NodeJS.ReadableStream, partSize: number, onChunk: (chunk: Buffer) => void) {
  let buffered: Buffer[] = [];
  let length = 0;
  for await (const value of body as AsyncIterable<Buffer | string>) {
    let chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    onChunk(chunk);
    while (length + chunk.length >= partSize) {
      const take = partSize - length;
      buffered.push(chunk.subarray(0, take));
      yield Buffer.concat(buffered);
      buffered = [];
      length = 0;
      chunk = chunk.subarray(take);
    }
    if (chunk.length === 0) {
      continue;
    }
    buffered.push(chunk);
    length += chunk.length;
  }

  if (length > 0) {
    yield Buffer.concat(buffered);
  }
}

/** Ranges the service would reject or silently ignore are rejected here instead */
const assertValidRange = (key: string, range: BlobRange, size?: number) => {
  const isValid =
    Number.isSafeInteger(range.start) &&
    range.start >= 0 &&
    (range.end === undefined || (Number.isSafeInteger(range.end) && range.end >= range.start)) &&
    (size === undefined || range.start < size);
  if (!isValid) {
    throw new BlobRangeError(key, range, size ?? -1);
  }
};

/**
 * Multi-object delete requires a body checksum. Content-MD5 is the one that every supported service documents, while
 * newer SDKs default to other algorithms that some services reject.
 */
type DeleteMiddleware = Parameters<DeleteObjectsCommand['middlewareStack']['addRelativeTo']>[0];
type Handler = (args: { request: unknown }) => Promise<unknown>;

const contentMd5 = (next: Handler) => (args: { request: unknown }) => {
  const request = args.request as { headers: Record<string, string>; body?: string | Uint8Array };
  for (const header of Object.keys(request.headers)) {
    const name = header.toLowerCase();
    if (name.startsWith('x-amz-checksum-') || name === 'x-amz-sdk-checksum-algorithm') {
      delete request.headers[header];
    }
  }
  request.headers['content-md5'] = createHash('md5')
    .update(request.body ?? '')
    .digest('base64');
  return next(args);
};

const addContentMd5 = (command: DeleteObjectsCommand) => {
  // a middleware that runs before signing, where the request is complete
  command.middlewareStack.addRelativeTo(contentMd5 as unknown as DeleteMiddleware, {
    relation: 'before',
    toMiddleware: 'httpSigningMiddleware',
    name: 'immichContentMd5',
  });
};
