import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3BackendOptions, createS3Client } from 'src/repositories/s3-blob-store.js';

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
