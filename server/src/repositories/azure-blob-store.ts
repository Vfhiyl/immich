import {
  AnonymousCredential,
  BlockBlobClient,
  ContainerClient,
  RequestPolicy,
  RequestPolicyFactory,
  RestError,
  StoragePipelineOptions,
  StorageSharedKeyCredential,
  WebResource,
  newPipeline,
} from '@azure/storage-blob';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { StorageRequest } from 'src/utils/storage-metering.js';
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

/** Blocks of 16 MiB, as the parts of S3: well within what a block may be (4000 MiB) */
export const AZURE_BLOCK_SIZE = 16 * 1024 * 1024;
/** Most blocks a blob can have */
const MAX_BLOCKS = 50_000;
/** Longest blob name, including the prefix */
const MAX_NAME_LENGTH = 1024;
const DELETE_CONCURRENCY = 16;

export interface AzureBackendOptions {
  /** The blob service of the storage account, e.g. https://<account>.blob.core.windows.net */
  endpoint: string;
  container: string;
  prefix: string;
  credentials:
    { type: 'sharedKey'; accountName: string; accountKeyFile: string } | { type: 'sas'; sasTokenFile: string };
}

/**
 * The operation of a request, by the name Azure documents it with: what it is charged as (write and list operations,
 * reads, and deletes)
 */
export const toAzureOperation = ({ method, url }: { method: string; url: string }) => {
  const comp = new URL(url).searchParams.get('comp');
  switch (method) {
    case 'GET': {
      return comp === 'list' ? 'ListBlobs' : comp === 'blocklist' ? 'GetBlockList' : 'GetBlob';
    }
    case 'HEAD': {
      return 'GetBlobProperties';
    }
    case 'DELETE': {
      return 'DeleteBlob';
    }
    case 'PUT': {
      return comp === 'block' ? 'PutBlock' : comp === 'blocklist' ? 'PutBlockList' : 'PutBlob';
    }
    default: {
      return method;
    }
  }
};

const contentLength = (headers: { get(name: string): string | undefined }) => {
  const value = Number(headers.get('content-length'));
  return Number.isFinite(value) ? value : 0;
};

/**
 * Report every request, with the bytes sent and received: what Azure charges for. Failed requests count too. Where the
 * SDK runs a policy of the pipeline is not documented: attempts that are retried may count once, which only makes the
 * estimate of the costs a little low while the service is busy.
 */
const meteringPolicy = (onRequest: (request: StorageRequest) => void): RequestPolicyFactory => ({
  create: (next: RequestPolicy): RequestPolicy => ({
    sendRequest: async (request: WebResource) => {
      const operation = toAzureOperation(request);
      const bytesSent = contentLength(request.headers);
      try {
        const response = await next.sendRequest(request);
        onRequest({ operation, bytesSent, bytesReceived: contentLength(response.headers) });
        return response;
      } catch (error) {
        onRequest({ operation, bytesSent, bytesReceived: 0 });
        throw error;
      }
    },
  }),
});

/** A client of the container of a backend; secrets are read from files, so that the configuration holds none */
export const createAzureContainerClient = (
  options: AzureBackendOptions,
  onRequest?: (request: StorageRequest) => void,
  pipelineOptions: StoragePipelineOptions = {},
) => {
  const { credentials } = options;
  const endpoint = options.endpoint.replace(/\/+$/, '');
  const credential =
    credentials.type === 'sharedKey'
      ? new StorageSharedKeyCredential(credentials.accountName, readFileSync(credentials.accountKeyFile, 'utf8').trim())
      : new AnonymousCredential();
  const pipeline = newPipeline(credential, {
    // exponential backoff, including for 503 Server Busy
    retryOptions: { maxTries: 5, tryTimeoutInMs: 120_000 },
    ...pipelineOptions,
  });
  if (onRequest) {
    pipeline.factories.push(meteringPolicy(onRequest));
  }
  const sas =
    credentials.type === 'sas' ? readFileSync(credentials.sasTokenFile, 'utf8').trim().replace(/^\?/, '') : '';
  const url = `${endpoint}/${encodeURIComponent(options.container)}${sas ? `?${sas}` : ''}`;
  return new ContainerClient(url, pipeline);
};

const errorCode = (error: unknown) => (error instanceof RestError ? error.code : undefined);
const statusCode = (error: unknown) => (error instanceof RestError ? error.statusCode : undefined);
const isNotFound = (error: unknown) => statusCode(error) === 404;

/** Block ids must all have the same length within a blob: the upload, and the number of the block */
const toBlockId = (uploadId: string, number: number) =>
  Buffer.from(`${uploadId}:${String(number).padStart(5, '0')}`).toString('base64');

/**
 * Blob store on Azure Blob Storage, with the same minimum contract as the S3 store: block blobs written once under
 * unique keys (no conditional writes), no checksums of the service (Immich computes size and SHA-1), equal-sized
 * blocks, and every read verified. Uploads in parts are blocks that are committed at the end; Azure keeps uncommitted
 * blocks for a week, so an upload that is not completed goes by itself.
 */
export class AzureBlobStore implements BlobStore {
  readonly limits: BlobStoreLimits = {
    maxDeleteBatch: 256,
    minPartSize: 1024 * 1024,
    maxParts: MAX_BLOCKS,
    presign: false,
    tracksUploads: false,
  };

  constructor(
    private readonly container: ContainerClient,
    private readonly prefix = '',
  ) {}

  async put(key: string, body: NodeJS.ReadableStream, options: BlobPutOptions = {}): Promise<BlobPutResult> {
    const blob = this.toBlob(key);
    const blockSize = getBlockSize(options.sizeHint);
    const hash = createHash('sha1');
    let size = 0;
    const blocks = readBlocks(body, blockSize, (chunk) => {
      size += chunk.length;
      hash.update(chunk);
    });

    const first = await blocks.next();
    const second = first.done || first.value.length < blockSize ? undefined : await blocks.next();
    if (!second || second.done) {
      const data = first.done ? Buffer.alloc(0) : (first.value as Buffer);
      await blob.upload(data, data.length, { blobHTTPHeaders: { blobContentType: 'application/octet-stream' } });
      return { size, sha1: hash.digest() };
    }

    const uploadId = randomUUID();
    const ids: string[] = [];
    const stage = async (data: Buffer) => {
      if (ids.length >= MAX_BLOCKS) {
        throw new Error(`${blob.name} needs more than ${MAX_BLOCKS} blocks of ${blockSize} bytes`);
      }
      const id = toBlockId(uploadId, ids.length + 1);
      await blob.stageBlock(id, data, data.length);
      ids.push(id);
    };
    await stage(first.value as Buffer);
    await stage(second.value as Buffer);
    for await (const data of blocks) {
      await stage(data);
    }
    await blob.commitBlockList(ids, { blobHTTPHeaders: { blobContentType: 'application/octet-stream' } });
    return { size, sha1: hash.digest() };
  }

  async get(key: string, { range, expect }: BlobGetOptions = {}): Promise<NodeJS.ReadableStream> {
    const blob = this.toBlob(key);
    if (range) {
      assertValidRange(key, range, expect?.size);
    }

    let response;
    try {
      response = await blob.download(
        range?.start ?? 0,
        range?.end === undefined ? undefined : range.end - range.start + 1,
      );
    } catch (error) {
      if (isNotFound(error)) {
        throw new BlobNotFoundError(key);
      }
      if (range && (errorCode(error) === 'InvalidRange' || statusCode(error) === 416)) {
        throw new BlobRangeError(key, range, expect?.size ?? -1);
      }
      throw error;
    }

    const stream = response.readableStreamBody;
    if (!stream) {
      throw new Error(`No content returned for ${blob.name}`);
    }
    try {
      const { total, length } = getResponseSize(key, range, response.contentRange, response.contentLength);
      if (expect && total !== expect.size) {
        throw new BlobIntegrityError(key, `expected ${expect.size} bytes but blob has ${total}`);
      }

      const verifier = createVerifyingStream(key, { length, sha1: range ? undefined : expect?.sha1 });
      stream.on('error', (error) => verifier.destroy(error));
      return stream.pipe(verifier);
    } catch (error) {
      (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      throw error;
    }
  }

  async head(key: string): Promise<BlobStat | null> {
    try {
      const properties = await this.toBlob(key).getProperties();
      return { size: properties.contentLength ?? 0 };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async deleteMany(keys: string[]): Promise<BlobDeleteResult> {
    const failed: string[] = [];
    for (let index = 0; index < keys.length; index += DELETE_CONCURRENCY) {
      await Promise.all(
        keys.slice(index, index + DELETE_CONCURRENCY).map(async (key) => {
          try {
            await this.toBlob(key).delete({ deleteSnapshots: 'include' });
          } catch (error) {
            // a blob that is already gone counts as deleted
            if (!isNotFound(error)) {
              failed.push(key);
            }
          }
        }),
      );
    }
    return { failed };
  }

  async *list(prefix = ''): AsyncIterable<BlobListEntry> {
    assertValidBlobPrefix(prefix);
    for await (const blob of this.container.listBlobsFlat({ prefix: this.prefix + prefix })) {
      if (blob.name.startsWith(this.prefix)) {
        yield {
          key: blob.name.slice(this.prefix.length),
          size: blob.properties.contentLength ?? 0,
          lastModified: blob.properties.lastModified ?? new Date(0),
        };
      }
    }
  }

  createUpload(key: string, { partSize }: BlobUploadOptions): Promise<BlobUpload> {
    this.toBlob(key);
    if (partSize < this.limits.minPartSize) {
      throw new Error(`Blocks of ${partSize} bytes are smaller than the ${this.limits.minPartSize} bytes allowed`);
    }
    // blocks are kept with the blob's name until they are committed; the id tells the blocks of this upload apart
    return Promise.resolve({ uploadId: randomUUID(), partSize });
  }

  async uploadPart(key: string, upload: BlobUpload, { number, data }: BlobUploadPart): Promise<UploadedPart> {
    const blob = this.toBlob(key);
    if (number < 1 || number > MAX_BLOCKS) {
      throw new Error(`Block ${number} of ${blob.name} is not between 1 and ${MAX_BLOCKS}`);
    }
    const id = toBlockId(upload.uploadId, number);
    await blob.stageBlock(id, data, data.length);
    return { number, etag: id, size: data.length };
  }

  async completeUpload(key: string, upload: BlobUpload, parts: UploadedPart[]): Promise<void> {
    const blob = this.toBlob(key);
    const size = parts.reduce((total, part) => total + part.size, 0);
    try {
      await blob.commitBlockList(
        parts.map(({ number }) => toBlockId(upload.uploadId, number)),
        { blobHTTPHeaders: { blobContentType: 'application/octet-stream' } },
      );
    } catch (error) {
      if (errorCode(error) !== 'InvalidBlockList') {
        throw error;
      }
      // a retried request can find the blocks committed by an attempt that timed out
      const stat = await this.head(key).catch(() => null);
      if (stat?.size === size) {
        return;
      }
      // the blocks are gone: Azure keeps uncommitted blocks for a week
      throw new BlobUploadNotFoundError(key, upload.uploadId);
    }
  }

  /** Uncommitted blocks cannot be deleted; Azure discards them after a week */
  abortUpload(): Promise<void> {
    return Promise.resolve();
  }

  private toBlob(key: string): BlockBlobClient {
    assertValidBlobKey(key);
    const name = this.prefix + key;
    if (name.length > MAX_NAME_LENGTH) {
      throw new Error(`Blob key is too long for an Azure backend: ${JSON.stringify(key)}`);
    }
    return this.container.getBlockBlobClient(name);
  }
}

/** Blocks are as large as needed to stay within the block limit, in steps of 256 KiB */
const getBlockSize = (sizeHint?: number) => {
  if (!sizeHint || sizeHint <= AZURE_BLOCK_SIZE * MAX_BLOCKS) {
    return AZURE_BLOCK_SIZE;
  }
  return Math.ceil(sizeHint / MAX_BLOCKS / (256 * 1024)) * 256 * 1024;
};

/** Split a stream into blocks of exactly `blockSize` bytes, except the last */
async function* readBlocks(body: NodeJS.ReadableStream, blockSize: number, onChunk: (chunk: Buffer) => void) {
  let buffered: Buffer[] = [];
  let length = 0;
  for await (const value of body as AsyncIterable<Buffer | string>) {
    let chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    onChunk(chunk);
    while (length + chunk.length >= blockSize) {
      const take = blockSize - length;
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

const getResponseSize = (key: string, range: BlobRange | undefined, contentRange?: string, contentLength?: number) => {
  if (!range) {
    return { total: contentLength ?? 0, length: contentLength ?? 0 };
  }

  // a service that ignores the range would send the whole blob as if it were the range
  const match = contentRange?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (!match || Number(match[1]) !== range.start) {
    throw new BlobIntegrityError(key, `unexpected content range ${contentRange} for ${range.start}-${range.end ?? ''}`);
  }

  const [, start, end, total] = match.map(Number);
  // Azure answers 416 for a range past the end, as HTTP has it; an emulator may answer with an empty range instead
  if (start >= total || end < start) {
    throw new BlobRangeError(key, range, total);
  }
  return { total, length: end - start + 1 };
};
