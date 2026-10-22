import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { StorageRequest } from 'src/utils/storage-metering.js';
import { BlobUploadNotFoundError } from 'src/repositories/blob-store.js';
import { S3BackendOptions, S3BlobStore, createS3Client, meterS3Client } from 'src/repositories/s3-blob-store.js';

// how the client talks to a service is checked here; how the store behaves against services is checked by the
// contract tests in test/contract
describe(createS3Client.name, () => {
  const options: S3BackendOptions = {
    endpoint: 'https://storage.example.com',
    region: 'region-1',
    bucket: 'photos',
    prefix: '',
    addressing: 'virtual-host',
    credentials: { type: 'chain' },
  };

  it('should read a static secret from its file', async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'immich-s3-'));
    try {
      const secretAccessKeyFile = join(directory, 'secret');
      await fs.writeFile(secretAccessKeyFile, 'the-secret\n');

      const client = createS3Client({
        ...options,
        credentials: { type: 'static', accessKeyId: 'AKID', secretAccessKeyFile },
      });

      await expect(client.config.credentials()).resolves.toEqual(
        expect.objectContaining({ accessKeyId: 'AKID', secretAccessKey: 'the-secret' }),
      );
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('should use path or virtual-host addressing as configured', () => {
    expect(createS3Client(options).config.forcePathStyle).toBe(false);
    expect(createS3Client({ ...options, addressing: 'path' }).config.forcePathStyle).toBe(true);
  });

  it('should only send checksums that a request requires', async () => {
    const { config } = createS3Client(options);
    await expect(config.requestChecksumCalculation()).resolves.toBe('WHEN_REQUIRED');
    await expect(config.responseChecksumValidation()).resolves.toBe('WHEN_REQUIRED');
  });

  it('should retry with backoff', async () => {
    const { config } = createS3Client(options);
    await expect(config.maxAttempts()).resolves.toBe(5);
    expect(config.retryMode).toBe('standard');
  });
});

/** Retries like the standard strategy, without pausing in between */
const retryToken = (count: number) => ({ getRetryCount: () => count, getRetryDelay: () => 0 });
const retryAtOnce = {
  mode: 'standard',
  acquireInitialRetryToken: () => Promise.resolve(retryToken(0)),
  refreshRetryTokenForRetry: (token: ReturnType<typeof retryToken>, error: unknown) =>
    token.getRetryCount() < 4 ? Promise.resolve(retryToken(token.getRetryCount() + 1)) : Promise.reject(error),
  recordSuccess: () => {},
};

describe(meterS3Client.name, () => {
  const options: S3BackendOptions = {
    endpoint: 'https://storage.example.com',
    region: 'region-1',
    bucket: 'photos',
    prefix: '',
    addressing: 'path',
    credentials: { type: 'chain' },
  };

  /** A client whose requests get canned responses, the first `failures` of them a 503 that is retried */
  const fakeClient = ({ failures = 0 } = {}) => {
    let calls = 0;
    const client = createS3Client(options, {
      credentials: { accessKeyId: 'AKID', secretAccessKey: 'secret' },
      requestHandler: {
        handle: () => {
          calls++;
          const failed = calls <= failures;
          const body = failed ? '<Error><Code>SlowDown</Code></Error>' : 'hello';
          return Promise.resolve({
            response: {
              statusCode: failed ? 503 : 200,
              headers: { 'content-length': String(body.length) },
              body: Readable.from([Buffer.from(body)]),
            },
          });
        },
      } as never,
      retryStrategy: retryAtOnce as never,
    });
    const requests: StorageRequest[] = [];
    meterS3Client(client, (request) => {
      requests.push(request);
    });
    return { client, requests };
  };

  it('should report every request with the bytes sent and received', async () => {
    const { client, requests } = fakeClient();

    await client.send(new PutObjectCommand({ Bucket: 'photos', Key: 'a', Body: Buffer.from('content') }));
    const { Body } = await client.send(new GetObjectCommand({ Bucket: 'photos', Key: 'a' }));
    await Body?.transformToString();

    expect(requests).toEqual([
      { operation: 'PutObject', bytesSent: 7, bytesReceived: 5 },
      { operation: 'GetObject', bytesSent: 0, bytesReceived: 5 },
    ]);
  });

  it('should report every attempt of a request that is retried, and failed requests', async () => {
    const { client, requests } = fakeClient({ failures: 2 });

    await client.send(new HeadObjectCommand({ Bucket: 'photos', Key: 'a' }));

    expect(requests.map(({ operation }) => operation)).toEqual(['HeadObject', 'HeadObject', 'HeadObject']);
  });
});

describe(S3BlobStore.name, () => {
  describe('uploadPart', () => {
    const options: S3BackendOptions = {
      endpoint: 'https://storage.example.com',
      region: 'region-1',
      bucket: 'photos',
      prefix: '',
      addressing: 'path',
      credentials: { type: 'chain' },
    };

    /** A service that resets the connection while a part is sent, and answers ListParts with `listParts` */
    const storeWithReset = (listParts: { status: number; body: string }) => {
      const client = createS3Client(options, {
        credentials: { accessKeyId: 'AKID', secretAccessKey: 'secret' },
        requestHandler: {
          handle: (request: { query?: Record<string, string> }) => {
            if (request.query?.partNumber) {
              return Promise.reject(Object.assign(new Error('write ECONNRESET'), { code: 'ECONNRESET' }));
            }
            return Promise.resolve({
              response: {
                statusCode: listParts.status,
                headers: { 'content-type': 'application/xml' },
                body: Readable.from([Buffer.from(listParts.body)]),
              },
            });
          },
        } as never,
        retryStrategy: retryAtOnce as never,
      });
      return new S3BlobStore(client, 'photos', '');
    };
    const upload = { uploadId: 'upload-id', partSize: 5 * 1024 * 1024 };

    it('should tell an upload the service dropped, when it closes the connection instead of answering', async () => {
      const store = storeWithReset({
        status: 404,
        body: '<Error><Code>NoSuchUpload</Code><Message>The upload does not exist</Message></Error>',
      });
      await expect(store.uploadPart('a', upload, { number: 1, data: Buffer.alloc(10) })).rejects.toThrow(
        BlobUploadNotFoundError,
      );
    });

    it('should report the connection error for an upload the service still knows', async () => {
      const store = storeWithReset({
        status: 200,
        body: '<ListPartsResult><Bucket>photos</Bucket><Key>a</Key><UploadId>upload-id</UploadId></ListPartsResult>',
      });
      await expect(store.uploadPart('a', upload, { number: 1, data: Buffer.alloc(10) })).rejects.toThrow('ECONNRESET');
    });
  });
});
