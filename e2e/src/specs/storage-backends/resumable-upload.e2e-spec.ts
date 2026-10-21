import { randomBytes } from 'node:crypto';
import { readFile, readdir, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  Api,
  ImmichServer,
  LocalBackend,
  S3Service,
  TestEnvironment,
  eventually,
  serverPort,
  sha1,
  testAssetDir,
} from 'src/storage-backends.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * Resumable uploads (draft-ietf-httpbis-resumable-upload) against a real server: without storage backends, with
 * encrypted local backends, and on an S3 service.
 */
const PART = 16 * 1024 * 1024;
const photoPath = join(testAssetDir, 'formats/jpg/el_torcal_rocks.jpg');

/** A JPEG larger than a few parts: decoders stop at its end marker and ignore what follows */
const largePhoto = async (extra = 2 * PART + 12_345) => Buffer.concat([await readFile(photoPath), randomBytes(extra)]);

const assetData = (filename: string) =>
  Buffer.from(
    JSON.stringify({
      filename,
      fileCreatedAt: '2021-01-01T00:00:00.000Z',
      fileModifiedAt: '2021-01-01T00:00:00.000Z',
      deviceAssetId: filename,
      deviceId: 'e2e',
    }),
  ).toString('base64url');

const digest = (content: Buffer) => `sha=:${Buffer.from(sha1(content), 'hex').toString('base64')}:`;

type Scenario = { name: string; backends?: (s3: S3Service | undefined) => LocalBackend[]; s3?: boolean };

const scenarios: Scenario[] = [
  { name: 'without storage backends' },
  {
    name: 'on encrypted local backends',
    backends: () => [
      { id: 'originals', role: 'originals', encrypted: true },
      { id: 'derived', role: 'derived', encrypted: true },
    ],
  },
  {
    name: 'on an S3 service',
    s3: true,
    backends: (s3) => [
      { id: 'originals', role: 'originals', s3: { service: s3!, prefix: 'originals/' } },
      { id: 'derived', role: 'derived', s3: { service: s3!, prefix: 'derived/' } },
    ],
  },
];

describe.each(scenarios)('resumable uploads $name', ({ backends, s3: withS3 }) => {
  let environment: TestEnvironment;
  let s3: S3Service | undefined;
  let server: ImmichServer;
  let api: Api;

  const create = (headers: Record<string, string>, body?: Buffer) =>
    api.raw('/upload', {
      method: 'POST',
      headers: { 'Upload-Draft-Interop-Version': '10', 'Content-Type': 'application/octet-stream', ...headers },
      body: body ? new Uint8Array(body) : undefined,
    });
  const append = (location: string, offset: number, content: Buffer, complete: boolean) =>
    api.raw(location.replace(/^\/api/, ''), {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/partial-upload',
        'Upload-Offset': String(offset),
        'Upload-Complete': complete ? '?1' : '?0',
      },
      body: new Uint8Array(content),
    });
  const head = (location: string) => api.raw(location.replace(/^\/api/, ''), { method: 'HEAD' });
  const offsetOf = async (location: string) => {
    const response = await head(location);
    return Number(response.headers.get('upload-offset'));
  };
  const begin = async (content: Buffer, name: string, headers: Record<string, string> = {}) => {
    const response = await create({
      'Upload-Complete': '?0',
      'Upload-Length': String(content.length),
      'Repr-Digest': digest(content),
      'X-Immich-Asset-Data': assetData(name),
      ...headers,
    });
    expect(response.status).toBe(201);
    return response.headers.get('location')!;
  };
  const expectOriginal = async (id: string, content: Buffer) => {
    const { status, body } = await api.download(`/assets/${id}/original`);
    expect(status).toBe(200);
    expect(body.equals(content)).toBe(true);
  };

  beforeAll(async () => {
    environment = await TestEnvironment.create();
    if (withS3) {
      s3 = await S3Service.start(environment);
    }
    if (backends) {
      await environment.writeBackends(backends(s3));
    }
    server = await ImmichServer.start(environment, { backends: !!backends });
    api = await Api.signUpAdmin();
  });

  afterEach(({ task }) => {
    if (task.result?.state === 'fail') {
      console.log(`Server output for "${task.name}":\n${server?.logs.split('\n').slice(-40).join('\n')}`);
    }
  });

  afterAll(async () => {
    await server?.stop();
    s3?.stop();
    await environment?.destroy();
  });

  it('should tell what it supports', async () => {
    const response = await api.raw('/upload', { method: 'OPTIONS' });
    expect(response.status).toBe(204);
    expect(response.headers.get('upload-limit')).toMatch(/^min-size=0, max-age=86400$/);
  });

  it('should take a file in one request', async () => {
    const content = await readFile(photoPath);
    const response = await create(
      {
        'Upload-Complete': '?1',
        'Upload-Length': String(content.length),
        'Repr-Digest': digest(content),
        'X-Immich-Asset-Data': assetData('single.jpg'),
      },
      content,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('upload-complete')).toBe('?1');
    const body = (await response.json()) as { id: string; status: string };
    expect(body).toEqual({ id: expect.any(String), status: 'created' });
    await expectOriginal(body.id, content);
  });

  it('should take a file of several parts over several requests, and report its progress', async () => {
    const content = await largePhoto();
    const location = await begin(content, 'parts.jpg');
    await expect(offsetOf(location)).resolves.toBe(0);

    const first = await append(location, 0, content.subarray(0, PART + 100), false);
    expect(first.status).toBe(204);
    expect(first.headers.get('upload-offset')).toBe(String(PART + 100));
    const headResponse = await head(location);
    expect(headResponse.headers.get('upload-offset')).toBe(String(PART + 100));
    expect(headResponse.headers.get('upload-complete')).toBe('?0');
    expect(headResponse.headers.get('cache-control')).toBe('no-store');

    // the offset must be the one the server has
    const wrong = await append(location, 5, content.subarray(5), true);
    expect(wrong.status).toBe(409);
    expect(wrong.headers.get('upload-offset')).toBe(String(PART + 100));
    await expect(wrong.json()).resolves.toMatchObject({ 'expected-offset': PART + 100, 'provided-offset': 5 });

    const last = await append(location, PART + 100, content.subarray(PART + 100), true);
    expect(last.status).toBe(200);
    const { id } = (await last.json()) as { id: string };
    await expectOriginal(id, content);

    // the result stays available for a client that missed it
    const after = await head(location);
    expect(after.headers.get('upload-complete')).toBe('?1');
    expect(after.headers.get('upload-offset')).toBe(String(content.length));
  });

  it('should resume an upload whose request was cut off', async () => {
    const content = await largePhoto();
    const location = await begin(content, 'interrupted.jpg');

    // send a part and a half, then drop the connection
    await new Promise<void>((resolve) => {
      const request = httpRequest({
        host: 'localhost',
        port: serverPort,
        path: location,
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${api.token}`,
          'Content-Type': 'application/partial-upload',
          'Upload-Offset': '0',
          'Upload-Complete': '?1',
          'Content-Length': String(content.length),
        },
      });
      request.on('error', () => resolve());
      request.write(content.subarray(0, PART + PART / 2), () => {
        void sleep(1000).then(() => {
          request.destroy();
          resolve();
        });
      });
    });

    const offset = await eventually(async () => {
      const offset = await offsetOf(location);
      expect(offset).toBeGreaterThan(0);
      return offset;
    });
    expect(offset).toBeLessThanOrEqual(PART + PART / 2);

    const rest = await append(location, offset, content.subarray(offset), true);
    expect(rest.status).toBe(200);
    const { id } = (await rest.json()) as { id: string };
    await expectOriginal(id, content);
  });

  it('should reject a file that does not match its declared SHA-1, and drop the upload', async () => {
    const content = await readFile(photoPath);
    const location = await begin(content, 'mismatch.jpg', { 'Repr-Digest': digest(randomBytes(10)) });

    const response = await append(location, 0, content, true);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ message: expect.stringContaining('SHA-1') });
    await expect(head(location)).resolves.toMatchObject({ status: 404 });
  });

  it('should not upload a file again that the user has', async () => {
    const content = await readFile(photoPath);
    const response = await create({
      'Upload-Complete': '?0',
      'Repr-Digest': digest(content),
      'X-Immich-Asset-Data': assetData('again.jpg'),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: expect.any(String), status: 'duplicate' });
  });

  it('should cancel an upload', async () => {
    const content = await largePhoto();
    const location = await begin(content, 'cancelled.jpg');
    await append(location, 0, content.subarray(0, PART + 1), false);

    const response = await api.raw(location.replace(/^\/api/, ''), { method: 'DELETE' });
    expect(response.status).toBe(204);
    await expect(head(location)).resolves.toMatchObject({ status: 404 });
  });

  it('should announce where to resume with an interim response', async () => {
    const informational = await new Promise<{ statusCode?: number; headers: Record<string, string> }>(
      (resolve, reject) => {
        const request = httpRequest({
          host: 'localhost',
          port: serverPort,
          path: '/api/upload',
          method: 'POST',
          headers: {
            Authorization: `Bearer ${api.token}`,
            'Upload-Draft-Interop-Version': '6',
            'Upload-Complete': '?0',
            'X-Immich-Asset-Data': assetData('interim.jpg'),
            'Content-Length': '0',
          },
        });
        request.on('information', (info) => resolve({ statusCode: info.statusCode, headers: info.headers as never }));
        request.on('response', (response) => {
          response.resume();
          reject(new Error(`no interim response before ${response.statusCode}`));
        });
        request.on('error', reject);
        request.end();
      },
    );

    expect(informational.statusCode).toBe(104);
    expect(informational.headers.location).toMatch(/^\/api\/upload\/[0-9a-f-]{36}$/);
    expect(informational.headers['upload-draft-interop-version']).toBe('6');
    // interop 6 knows the lifetime as expires
    expect(informational.headers['upload-limit']).toContain('expires=');
  });

  if (backends && !withS3) {
    it('should start again from the beginning when the backend dropped the upload', async () => {
      const content = await largePhoto();
      const location = await begin(content, 'dropped.jpg');
      await append(location, 0, content.subarray(0, PART + 1), false);

      // what a service that drops unfinished uploads does
      const root = environment.backendRoot('originals');
      for (const name of await readdir(root)) {
        if (name.includes('.upload.')) {
          await rm(join(root, name), { recursive: true });
        }
      }

      const response = await append(location, PART + 1, content.subarray(PART + 1), true);
      expect(response.status).toBe(409);
      expect(response.headers.get('upload-offset')).toBe('0');

      const again = await append(location, 0, content, true);
      expect(again.status).toBe(200);
      const { id } = (await again.json()) as { id: string };
      await expectOriginal(id, content);
    });
  }
});
