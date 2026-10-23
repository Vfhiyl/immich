import fs from 'node:fs/promises';
import { IncomingMessage, Server, ServerResponse, createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StorageRequest } from 'src/utils/storage-metering.js';
import {
  AzureBackendOptions,
  createAzureContainerClient,
  toAzureOperation,
} from 'src/repositories/azure-blob-store.js';

// how the client talks to a service is checked here; how the store behaves against a service is checked by the
// contract tests in test/contract, against Azurite
const url = (query = '') => `https://account.blob.core.windows.net/photos/a${query}`;

describe(toAzureOperation.name, () => {
  it.each([
    ['GET', url(), 'GetBlob'],
    ['GET', 'https://account.blob.core.windows.net/photos?restype=container&comp=list', 'ListBlobs'],
    ['GET', url('?comp=blocklist'), 'GetBlockList'],
    ['HEAD', url(), 'GetBlobProperties'],
    ['DELETE', url(), 'DeleteBlob'],
    ['PUT', url(), 'PutBlob'],
    ['PUT', url('?comp=block&blockid=YQ%3D%3D'), 'PutBlock'],
    ['PUT', url('?comp=blocklist'), 'PutBlockList'],
    ['POST', url(), 'POST'],
  ])('should name %s %s as %s', (method, requestUrl, operation) => {
    expect(toAzureOperation({ method, url: requestUrl })).toBe(operation);
  });
});

describe(createAzureContainerClient.name, () => {
  let directory: string;
  let server: Server;
  let endpoint: string;
  let received: { method: string; url: string; authorization?: string }[];
  let failures: number;

  /** A service that answers every request with a small body, the first `failures` of them with 503 Server Busy */
  const handle = (request: IncomingMessage, response: ServerResponse) => {
    received.push({ method: request.method!, url: request.url!, authorization: request.headers.authorization });
    request.resume();
    request.on('end', () => {
      if (received.length <= failures) {
        response.writeHead(503, { 'x-ms-error-code': 'ServerBusy', 'content-length': '0' }).end();
        return;
      }
      response
        .writeHead(request.method === 'PUT' ? 201 : 200, {
          'content-length': '5',
          'content-type': 'application/octet-stream',
          etag: '"0x1"',
        })
        .end('hello');
    });
  };

  const options = (credentials: AzureBackendOptions['credentials']): AzureBackendOptions => ({
    endpoint: `${endpoint}/`,
    container: 'photos',
    prefix: '',
    credentials,
  });

  const fastRetries = { retryOptions: { maxTries: 3, retryDelayInMs: 1, maxRetryDelayInMs: 1 } };

  beforeAll(async () => {
    server = createServer(handle);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/account`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'immich-azure-'));
    received = [];
    failures = 0;
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('should sign requests with the account key read from its file', async () => {
    const accountKeyFile = join(directory, 'key');
    await fs.writeFile(accountKeyFile, `${Buffer.from('secret').toString('base64')}\n`);
    const client = createAzureContainerClient(options({ type: 'sharedKey', accountName: 'account', accountKeyFile }));

    await client.getBlockBlobClient('a').getProperties();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ method: 'HEAD', authorization: expect.stringMatching(/^SharedKey account:/) });
    expect(new URL(received[0].url, endpoint).pathname).toBe('/account/photos/a');
  });

  it('should add the shared access signature read from its file to every request', async () => {
    const sasTokenFile = join(directory, 'sas');
    await fs.writeFile(sasTokenFile, '?sv=2024-11-04&sig=abc\n');
    const client = createAzureContainerClient(options({ type: 'sas', sasTokenFile }));

    await client.getBlockBlobClient('a').getProperties();

    expect(received).toHaveLength(1);
    expect(received[0].authorization).toBeUndefined();
    const url = new URL(received[0].url, endpoint);
    expect(url.pathname).toBe('/account/photos/a');
    expect(url.searchParams.get('sv')).toBe('2024-11-04');
    expect(url.searchParams.get('sig')).toBe('abc');
  });

  it('should report every request with the bytes sent and received', async () => {
    const sasTokenFile = join(directory, 'sas');
    await fs.writeFile(sasTokenFile, 'sig=abc');
    const requests: StorageRequest[] = [];
    const client = createAzureContainerClient(
      options({ type: 'sas', sasTokenFile }),
      (request) => {
        requests.push(request);
      },
      fastRetries,
    );

    await client.getBlockBlobClient('a').upload(Buffer.from('content'), 7);
    const { readableStreamBody } = await client.getBlockBlobClient('a').download();
    const chunks: Buffer[] = [];
    for await (const chunk of readableStreamBody!) {
      chunks.push(chunk as Buffer);
    }

    expect(Buffer.concat(chunks).toString()).toBe('hello');
    expect(requests).toEqual([
      { operation: 'PutBlob', bytesSent: 7, bytesReceived: 5 },
      { operation: 'GetBlob', bytesSent: 0, bytesReceived: 5 },
    ]);
  });

  it('should retry a busy service, and report the request', async () => {
    const sasTokenFile = join(directory, 'sas');
    await fs.writeFile(sasTokenFile, 'sig=abc');
    failures = 2;
    const requests: StorageRequest[] = [];
    const client = createAzureContainerClient(
      options({ type: 'sas', sasTokenFile }),
      (request) => {
        requests.push(request);
      },
      fastRetries,
    );

    await client.getBlockBlobClient('a').getProperties();

    expect(received).toHaveLength(3);
    // whether the attempts that are retried are reported too is up to where the SDK puts the policy
    expect(requests.length).toBeGreaterThanOrEqual(1);
    expect(requests.every(({ operation }) => operation === 'GetBlobProperties')).toBe(true);
  });
});
