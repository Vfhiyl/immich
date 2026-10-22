import {
  AbortedError,
  MemorySessionStore,
  NetworkError,
  ResumableUploader,
  UploadInterruptedError,
  UploadRejectedError,
  type TransportRequest,
  type TransportResponse,
} from '@immich/sdk';
import { beforeEach, describe, expect, it } from 'vitest';

const baseUrl = 'https://immich.example.com/api';
const checksum = 'a9993e364706816aba3e25717850c26c9cd0d89d';
const assetData = {
  filename: 'IMG_0001.jpg',
  fileCreatedAt: '2026-10-22T10:00:00.000Z',
  fileModifiedAt: '2026-10-22T10:00:00.000Z',
};

type Upload = { received: Uint8Array; length: number; assetData: unknown; digest: string; assetId?: string };

/** The server's side of resumable uploads, in memory */
class FakeServer {
  uploads = new Map<string, Upload>();
  requests: string[] = [];
  maxAppendSize: number | undefined = 1000;
  supportsUploads = true;
  existingChecksums = new Map<string, string>();
  /** Cuts the connection after this many bytes of the next part (the server keeps what it received) */
  cutAfter: number | undefined;
  failNextPart: number | undefined;
  #next = 1;

  transport = async ({ method, url, headers, body, onProgress }: TransportRequest): Promise<TransportResponse> => {
    const path = new URL(url).pathname;
    this.requests.push(`${method} ${path}`);
    const respond = (status: number, responseHeaders: Record<string, string> = {}, json?: unknown) => ({
      status,
      header: (name: string) => responseHeaders[name.toLowerCase()] ?? null,
      body: json === undefined ? '' : JSON.stringify(json),
    });

    if (method === 'OPTIONS') {
      if (!this.supportsUploads) {
        return respond(404);
      }
      return respond(204, {
        'upload-limit':
          this.maxAppendSize === undefined ? 'min-size=0' : `min-size=0, max-append-size=${this.maxAppendSize}`,
      });
    }

    if (method === 'POST') {
      const digest = headers['Repr-Digest'];
      const existing = this.existingChecksums.get(digest);
      if (existing) {
        return respond(200, {}, { id: existing, status: 'duplicate' });
      }
      const id = `upload-${this.#next++}`;
      const json = atob(headers['X-Immich-Asset-Data'].replaceAll('-', '+').replaceAll('_', '/'));
      this.uploads.set(id, {
        received: new Uint8Array(),
        length: Number(headers['Upload-Length']),
        assetData: JSON.parse(json),
        digest,
      });
      return respond(201, { location: `/api/upload/${id}` });
    }

    const id = path.split('/').pop()!;
    const upload = this.uploads.get(id);
    if (!upload) {
      return respond(404);
    }

    if (method === 'HEAD') {
      return respond(204, {
        'upload-offset': String(upload.received.length),
        'upload-complete': upload.assetId ? '?1' : '?0',
        ...(upload.assetId && { 'x-immich-asset-id': upload.assetId }),
      });
    }

    // PATCH
    if (this.failNextPart) {
      const status = this.failNextPart;
      this.failNextPart = undefined;
      return respond(status, {}, { message: 'The part failed' });
    }
    if (Number(headers['Upload-Offset']) !== upload.received.length) {
      return respond(409);
    }
    let bytes = new Uint8Array(await body!.arrayBuffer());
    const cut = this.cutAfter !== undefined && this.cutAfter < bytes.length;
    if (cut) {
      bytes = bytes.slice(0, this.cutAfter);
      this.cutAfter = undefined;
    }
    upload.received = new Uint8Array([...upload.received, ...bytes]);
    onProgress?.(bytes.length);
    if (cut) {
      throw new NetworkError('connection reset');
    }
    if (headers['Upload-Complete'] === '?1') {
      upload.assetId = `asset-${id}`;
      return respond(200, {}, { id: upload.assetId, status: 'created' });
    }
    return respond(204, { 'upload-offset': String(upload.received.length) });
  };
}

const fileOf = (size: number) => new Blob([Uint8Array.from({ length: size }, (_, i) => (i * 7) % 256)]);
const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

describe(ResumableUploader.name, () => {
  let server: FakeServer;
  let sessions: MemorySessionStore;
  let sut: ResumableUploader;

  const upload = (file: Blob, options: { signal?: AbortSignal; onProgress?: (loaded: number) => void } = {}) =>
    sut.upload({ baseUrl, file, checksum, assetData, sessionKey: 'user:IMG_0001.jpg:2500:1', ...options });

  beforeEach(() => {
    server = new FakeServer();
    sessions = new MemorySessionStore();
    sut = new ResumableUploader(server.transport, sessions, [0, 0]);
  });

  it('tells whether the server takes resumable uploads, asking once', async () => {
    expect(await sut.getOptions(baseUrl)).toEqual({ maxAppendSize: 1000 });
    await sut.getOptions(baseUrl);
    expect(server.requests).toEqual(['OPTIONS /api/upload']);

    server.supportsUploads = false;
    expect(await new ResumableUploader(server.transport, sessions).getOptions(baseUrl)).toBeUndefined();
  });

  it('uploads in parts no larger than the server takes, with what describes the photo', async () => {
    const file = fileOf(2500);

    await expect(upload(file)).resolves.toEqual({ id: 'asset-upload-1', status: 'created' });

    const uploaded = server.uploads.get('upload-1')!;
    expect(uploaded.received).toEqual(await bytesOf(file));
    expect(uploaded.assetData).toEqual(assetData);
    // the SHA-1 as base64, as the protocol has it
    expect(uploaded.digest).toBe('sha=:qZk+NkcGgWq6PiVxeFDCbJzQ2J0=:');
    expect(server.requests).toEqual([
      'OPTIONS /api/upload',
      'POST /api/upload',
      'HEAD /api/upload/upload-1',
      'PATCH /api/upload/upload-1',
      'PATCH /api/upload/upload-1',
      'PATCH /api/upload/upload-1',
    ]);
    expect(sessions.sessions.size).toBe(0);
  });

  it('does not send a file the user has already', async () => {
    server.existingChecksums.set('sha=:qZk+NkcGgWq6PiVxeFDCbJzQ2J0=:', 'existing');

    await expect(upload(fileOf(10))).resolves.toEqual({ id: 'existing', status: 'duplicate' });
    expect(server.requests).toEqual(['OPTIONS /api/upload', 'POST /api/upload']);
  });

  it('goes on where the server stopped receiving when the connection is cut', async () => {
    const file = fileOf(2500);
    server.cutAfter = 300;

    await expect(upload(file)).resolves.toEqual({ id: 'asset-upload-1', status: 'created' });

    expect(server.uploads.get('upload-1')!.received).toEqual(await bytesOf(file));
    expect(server.requests.filter((request) => request.startsWith('HEAD'))).toHaveLength(2);
  });

  it('goes on with the upload of a file selected again, after the page was reloaded', async () => {
    const file = fileOf(2500);
    server.cutAfter = 300;
    sut = new ResumableUploader(server.transport, sessions, []);
    await expect(upload(file)).rejects.toThrow(UploadInterruptedError);
    expect(sessions.sessions.size).toBe(1);

    sut = new ResumableUploader(server.transport, sessions);
    await expect(upload(file)).resolves.toEqual({ id: 'asset-upload-1', status: 'created' });

    expect(server.uploads.size).toBe(1);
    expect(server.uploads.get('upload-1')!.received).toEqual(await bytesOf(file));
  });

  it('learns the asset of an upload that completed when the answer was lost', async () => {
    const file = fileOf(500);
    await upload(file);
    await sessions.put('user:IMG_0001.jpg:2500:1', { location: '/api/upload/upload-1', size: 500, checksum });
    server.requests = [];

    await expect(upload(file)).resolves.toEqual({ id: 'asset-upload-1', status: 'created' });
    expect(server.requests).toEqual(['HEAD /api/upload/upload-1']);
  });

  it('starts again when the server no longer knows the upload', async () => {
    await sessions.put('user:IMG_0001.jpg:2500:1', { location: '/api/upload/expired', size: 500, checksum });

    await expect(upload(fileOf(500))).resolves.toEqual({ id: 'asset-upload-1', status: 'created' });
    expect(server.requests.slice(1, 3)).toEqual(['HEAD /api/upload/expired', 'POST /api/upload']);
  });

  it('does not go on with the upload of a file that changed since', async () => {
    await sessions.put('user:IMG_0001.jpg:2500:1', { location: '/api/upload/old', size: 500, checksum: 'other' });

    await upload(fileOf(500));

    expect(server.requests[1]).toBe('POST /api/upload');
  });

  it('gives up on an upload the server rejected, and forgets it', async () => {
    server.failNextPart = 400;

    await expect(upload(fileOf(500))).rejects.toEqual(new UploadRejectedError('The part failed', 400));
    expect(sessions.sessions.size).toBe(0);
  });

  it('tries again after an error of the server', async () => {
    server.failNextPart = 503;

    await expect(upload(fileOf(500))).resolves.toEqual({ id: 'asset-upload-1', status: 'created' });
  });

  it('stops when cancelled, and keeps the upload to go on with', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(upload(fileOf(500), { signal: controller.signal })).rejects.toThrow(AbortedError);
  });

  it('reports progress up to the whole file', async () => {
    const progress: number[] = [];

    await sut.upload({
      baseUrl,
      file: fileOf(2500),
      checksum,
      assetData,
      sessionKey: 'key',
      onProgress: (loaded, total) => {
        expect(total).toBe(2500);
        progress.push(loaded);
      },
    });

    expect(progress.at(-1)).toBe(2500);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });
});
