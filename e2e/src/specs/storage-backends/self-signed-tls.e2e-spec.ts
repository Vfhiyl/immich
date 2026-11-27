import { createHash, X509Certificate } from 'node:crypto';
import { request } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { Api, appPort, baseUrl, ImmichServer, TestEnvironment } from 'src/storage-backends.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
Self-signed mode (docs: administration/self-signed-tls): the server makes its own key and certificate; its HTTPS port serves
the mobile app only, which pins the key it gets with the QR code; the web and the administration stay on a port of
their own.
*/

type Response = { status: number; body: string; pin: string };

/** A request as the mobile app makes it: trusting no CA, but checking the server's key against the pin */
const appRequest = (
  path: string,
  { method = 'GET', body, token }: { method?: string; body?: unknown; token?: string } = {},
) =>
  new Promise<Response>((resolve, reject) => {
    const outgoing = request(
      {
        host: '127.0.0.1',
        port: appPort,
        path,
        method,
        // the app checks the pin instead
        rejectUnauthorized: false,
        headers: {
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
          ...(token && { Authorization: `Bearer ${token}` }),
        },
      },
      (response) => {
        // (the socket goes back to the agent at the end)
        const certificate = new X509Certificate((response.socket as TLSSocket).getPeerCertificate().raw);
        const pin = createHash('sha256')
          .update(certificate.publicKey.export({ type: 'spki', format: 'der' }))
          .digest('base64');
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString(), pin });
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });

/** The status of a request as the mobile app makes it */
const appStatus = async (path: string, options: Parameters<typeof appRequest>[1] = {}) => {
  const { status } = await appRequest(path, options);
  return status;
};

describe('self-signed mode', () => {
  let environment: TestEnvironment;
  let server: ImmichServer;
  let admin: Api;
  let userId: string;

  /** What the QR code of an administrator holds, for the user */
  const loginCode = async () => {
    const { status, body } = await admin.json<{ url: string; pin?: string }>(`/admin/users/${userId}/login-codes`, {
      method: 'POST',
    });
    expect(status).toBe(201);
    const url = new URL(body.url);
    return { code: url.searchParams.get('code')!, pin: url.searchParams.get('pin'), response: body };
  };

  beforeAll(async () => {
    environment = await TestEnvironment.create({ configFile: false });
    server = await ImmichServer.start(environment, { backends: false, selfSignedTls: true });
    admin = await Api.signUpAdmin();
    await admin.configure();
    const { body: config } = await admin.json<{ server: object }>('/system-config');
    await admin.json('/system-config', {
      method: 'PUT',
      body: { ...config, server: { ...config.server, externalDomain: `https://203.0.113.7:${appPort}` } },
    });
    const { body } = await admin.json<{ id: string }>('/admin/users', {
      method: 'POST',
      body: { email: 'ann@immich.cloud', password: 'a password nobody types on a phone', name: 'Ann' },
    });
    userId = body.id;
  });

  afterAll(async () => {
    await server?.stop();
    await environment?.destroy();
  });

  it('should give the key of the HTTPS port with the QR code, as the log shows it', async () => {
    const { pin, response } = await loginCode();
    const { pin: served } = await appRequest('/api/server/ping');

    expect(pin).toBe(served);
    expect(response.pin).toBe(served);
    const hex = Buffer.from(served, 'base64').toString('hex').toUpperCase();
    expect(server.logs).toContain(hex.match(/.{4}/g)!.join(' '));
  });

  it('should sign the phone in with the code on the HTTPS port, and serve the app there', async () => {
    const { code } = await loginCode();

    const login = await appRequest('/api/auth/login-code', { method: 'POST', body: { code } });
    expect(login.status).toBe(201);
    const { accessToken } = JSON.parse(login.body) as { accessToken: string };

    expect(await appStatus('/api/users/me', { token: accessToken })).toBe(200);
    expect(await appStatus('/api/timeline/buckets', { token: accessToken })).toBe(200);
    for (const path of ['/api/server/ping', '/api/server/version', '/api/server/features', '/.well-known/immich']) {
      expect(await appStatus(path), path).toBe(200);
    }
    expect(await appStatus('/api/upload', { method: 'OPTIONS' })).toBe(204);
  });

  it('should have no web, administration, password sign-in or shared links on the HTTPS port', async () => {
    for (const path of ['/', '/photos', '/custom.css', '/admin/users']) {
      expect(await appStatus(path), path).toBe(404);
    }
    const login = await appRequest('/api/auth/login', {
      method: 'POST',
      body: { email: 'admin@immich.cloud', password: 'admin' },
    });
    expect(login.status).toBe(403);
    expect(await appStatus('/api/oauth/authorize', { method: 'POST', body: {} })).toBe(403);
    // not even with the session of an administrator
    expect(await appStatus('/api/admin/users', { token: admin.token })).toBe(403);
    expect(await appStatus('/api/system-config', { token: admin.token })).toBe(403);

    const { body: album } = await admin.json<{ id: string }>('/albums', { method: 'POST', body: { albumName: 'A' } });
    const { body: link } = await admin.json<{ key: string }>('/shared-links', {
      method: 'POST',
      body: { type: 'ALBUM', albumId: album.id },
    });
    const shared = await fetch(`${baseUrl}/shared-links/me?key=${link.key}`);
    expect(shared.status).toBe(200);
    expect(await appStatus(`/api/shared-links/me?key=${link.key}`)).toBe(403);
  });

  it('should keep the key when the server starts again', async () => {
    const before = await appRequest('/api/server/ping');
    await server.stop();
    server = await ImmichServer.start(environment, { backends: false, selfSignedTls: true });

    const after = await appRequest('/api/server/ping');
    expect(after.pin).toBe(before.pin);
    expect(server.logs).not.toContain('Created the key of the HTTPS port');
  });
});
