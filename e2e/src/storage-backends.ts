import { ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * Runs a real Immich server (API and microservices workers) as a local process, so that storage backend scenarios
 * can be tested end to end, including restarts with another configuration. It needs PostgreSQL with the vector
 * extension and Redis, which `src/specs/storage-backends/setup.ts` provides, and a built server (`server/dist`).
 */

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../server');
export const testAssetDir = resolve(dirname(fileURLToPath(import.meta.url)), '../test-assets');

const postgresBase = process.env.E2E_STORAGE_POSTGRES_URL ?? 'postgres://postgres:postgres@localhost:5432';
export const redisPort = Number(process.env.E2E_STORAGE_REDIS_PORT ?? 6391);
const port = Number(process.env.E2E_STORAGE_PORT ?? 2290);
export const baseUrl = `http://localhost:${port}/api`;

export interface LocalBackend {
  id: string;
  role: 'originals' | 'derived' | 'backup';
  /** Store the backend's files on an S3 service, below this prefix, instead of a local folder */
  s3?: { service: S3Service; prefix: string };
  /** Whether new files are encrypted; the server encrypts S3 backends unless told otherwise */
  encrypted?: boolean;
}

/** A versitygw S3 service storing objects as files, so that tests can look at what was stored */
export class S3Service {
  static async start(environment: TestEnvironment) {
    // provided by the global setup: the S3 service the server's contract tests use, at the same pinned version
    const executable = process.env.E2E_VERSITYGW;
    if (!executable) {
      throw new Error('E2E_VERSITYGW is not set; it is set by src/specs/storage-backends/setup.ts');
    }
    const root = join(environment.root, 's3');
    const bucket = 'immich';
    await mkdir(join(root, bucket), { recursive: true });
    const accessKeyId = randomUUID();
    const secretAccessKeyFile = join(environment.root, 's3-secret');
    const secret = randomUUID();
    await writeFile(secretAccessKeyFile, secret);

    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const child = spawn(
      executable,
      ['--access', accessKeyId, '--secret', secret, '--port', `127.0.0.1:${port}`, 'posix', root],
      { stdio: 'ignore' },
    );
    const service = new this(child, `http://127.0.0.1:${port}`, root, bucket, accessKeyId, secretAccessKeyFile);
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await fetch(service.endpoint);
        return service;
      } catch {
        await sleep(100);
      }
    }
    child.kill();
    throw new Error('The S3 service did not start');
  }

  private constructor(
    private process: ChildProcess,
    readonly endpoint: string,
    /** Objects are files at root/bucket/key */
    readonly root: string,
    readonly bucket: string,
    readonly accessKeyId: string,
    readonly secretAccessKeyFile: string,
  ) {}

  stop() {
    this.process.kill();
  }
}

export const sha1 = (value: Buffer) => createHash('sha1').update(value).digest('hex');

/** A directory with everything one test environment writes: media location, backends and configuration */
export class TestEnvironment {
  static async create() {
    const environment = new this(await mkdtemp(join(tmpdir(), 'immich-e2e-storage-')));
    await environment.writeBuildData();
    await writeFile(
      environment.configFile,
      JSON.stringify({
        machineLearning: { enabled: false },
        newVersionCheck: { enabled: false },
        reverseGeocoding: { enabled: false },
      }),
    );
    await withDatabase('postgres', (client) => client.query(`CREATE DATABASE ${environment.database}`));
    return environment;
  }

  private backendFolders = new Map<string, string>();
  readonly database = `immich_e2e_storage_${randomUUID().slice(0, 8)}`;

  private constructor(readonly root: string) {}

  /** The server imports reverse geocoding data on startup; one placeholder row of each file is enough */
  private async writeBuildData() {
    const geodata = join(this.root, 'build', 'geodata');
    await mkdir(geodata, { recursive: true });
    await mkdir(join(this.root, 'build', 'www'), { recursive: true });
    const files: Record<string, string> = {
      'geodata-date.txt': '2024-01-01\n',
      'admin1CodesASCII.txt': 'TS.01\tTest Region\tTest Region\t1\n',
      'admin2Codes.txt': 'TS.01.001\tTest County\tTest County\t2\n',
      'cities500.txt':
        '3\tTest City\tTest City\t\t0.5\t0.5\tP\tPPL\tTS\t\t01\t001\t\t\t1000\t\t1\tEtc/UTC\t2024-01-01\n',
      'countryInfo.txt': 'TS\tTST\t999\tTS\tTestland\n',
      'ne_10m_admin_0_countries.geojson': JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { ADMIN: 'Testland', ADM0_A3: 'TST', TYPE: 'Country' },
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [0, 0],
                  [1, 0],
                  [1, 1],
                  [0, 1],
                  [0, 0],
                ],
              ],
            },
          },
        ],
      }),
    };
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(geodata, name), content);
    }
  }

  get mediaLocation() {
    return join(this.root, 'media');
  }

  get configFile() {
    return join(this.root, 'immich-config.json');
  }

  get backendsFile() {
    return join(this.root, 'storage.yaml');
  }

  /** The folder that holds a backend's files, also for backends on the S3 service */
  backendRoot(id: string) {
    return this.backendFolders.get(id) ?? join(this.root, 'backends', id);
  }

  get masterKeyFile() {
    return join(this.root, 'master.key');
  }

  async writeBackends(backends: LocalBackend[]) {
    const lines = [];
    if (backends.some(({ s3, encrypted }) => encrypted ?? !!s3)) {
      await writeFile(this.masterKeyFile, `${randomBytes(32).toString('base64')}\n`);
      lines.push('encryption:', `  masterKeyFile: ${this.masterKeyFile}`);
    }

    lines.push('backends:');
    for (const { id, role, s3, encrypted } of backends) {
      lines.push(`  - id: ${id}`, `    role: ${role}`);
      if (encrypted !== undefined) {
        lines.push(`    encrypted: ${encrypted}`);
      }
      if (s3) {
        const { service, prefix } = s3;
        this.backendFolders.set(id, join(service.root, service.bucket, prefix));
        lines.push(
          '    driver: s3',
          `    endpoint: ${service.endpoint}`,
          '    region: us-east-1',
          `    bucket: ${service.bucket}`,
          `    prefix: ${prefix}`,
          '    addressing: path',
          '    credentials:',
          '      type: static',
          `      accessKeyId: ${service.accessKeyId}`,
          `      secretAccessKeyFile: ${service.secretAccessKeyFile}`,
        );
      } else {
        lines.push('    driver: local', `    root: ${this.backendRoot(id)}`);
      }
    }
    await writeFile(this.backendsFile, lines.join('\n') + (backends.length === 0 ? ' []' : '') + '\n');
  }

  /** Files stored on a backend, without the probes of the startup check */
  async listBackend(id: string) {
    const entries = await readdirIfExists(this.backendRoot(id));
    return entries.filter((name) => name !== '.immich-probe').toSorted((a, b) => a.localeCompare(b));
  }

  listStaging() {
    return readdirIfExists(join(this.mediaLocation, '.immich-staging'));
  }

  query<T extends pg.QueryResultRow>(text: string, values?: unknown[]) {
    return withDatabase(this.database, async (client) => {
      const { rows } = await client.query<T>(text, values);
      return rows;
    });
  }

  async destroy() {
    await withDatabase('postgres', (client) => client.query(`DROP DATABASE IF EXISTS ${this.database} WITH (FORCE)`));
    await rm(this.root, { recursive: true, force: true });
  }
}

const readdirIfExists = async (path: string) => {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
};

const withDatabase = async <T>(database: string, fn: (client: pg.Client) => Promise<T>) => {
  const client = new pg.Client(`${postgresBase}/${database}`);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
};

/** A running server; `start` resolves once both workers are ready, or rejects with the output if it exits */
export class ImmichServer {
  static async start(environment: TestEnvironment, { backends = true }: { backends?: boolean } = {}) {
    const child = spawn(process.execPath, ['dist/main.js'], {
      cwd: serverRoot,
      // a process group, so that the workers are stopped with the server
      detached: true,
      env: {
        ...process.env,
        DB_URL: `${postgresBase}/${environment.database}`,
        DB_VECTOR_EXTENSION: process.env.DB_VECTOR_EXTENSION ?? 'pgvector',
        REDIS_HOSTNAME: 'localhost',
        REDIS_PORT: String(redisPort),
        IMMICH_PORT: String(port),
        IMMICH_MEDIA_LOCATION: environment.mediaLocation,
        IMMICH_CONFIG_FILE: environment.configFile,
        IMMICH_BUILD_DATA: join(environment.root, 'build'),
        IMMICH_LOG_LEVEL: 'log',
        NO_COLOR: 'true',
        ...(backends && { IMMICH_STORAGE_BACKENDS: environment.backendsFile }),
      },
    });

    const server = new this(child);
    await server.waitUntilReady();
    return server;
  }

  private output: string[] = [];
  private exited?: number | null;

  private constructor(private process: ChildProcess) {
    process.stdout?.on('data', (data) => {
      this.output.push(data.toString());
    });
    process.stderr?.on('data', (data) => {
      this.output.push(data.toString());
    });
    process.on('exit', (code) => (this.exited = code));
  }

  private async waitUntilReady() {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (this.exited !== undefined) {
        throw new Error(`The server exited with code ${this.exited}:\n${this.logs}`);
      }

      if (this.logs.includes('Immich Microservices is running') && (await isApiUp())) {
        return;
      }

      await sleep(200);
    }

    await this.stop();
    throw new Error(`The server did not start in time:\n${this.logs}`);
  }

  get logs() {
    return this.output.join('');
  }

  async stop() {
    if (this.exited === undefined && this.process.pid) {
      process.kill(-this.process.pid, 'SIGTERM');
    }
    for (let attempt = 0; attempt < 100 && this.exited === undefined; attempt++) {
      await sleep(100);
    }
  }
}

const isApiUp = async () => {
  try {
    const response = await fetch(`${baseUrl}/server/ping`);
    return response.ok;
  } catch {
    return false;
  }
};

/** Retry an assertion until it passes, for results of background jobs */
export const eventually = async <T>(check: () => Promise<T>, { timeout = 30_000 } = {}): Promise<T> => {
  const started = Date.now();
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() - started > timeout) {
        throw error;
      }
      await sleep(250);
    }
  }
};

export class Api {
  static async signUpAdmin() {
    const credentials = { email: 'admin@immich.cloud', password: 'admin' };
    await fetch(`${baseUrl}/auth/admin-sign-up`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...credentials, name: 'Admin' }),
    });
    return this.login(credentials);
  }

  static async login(credentials: { email: string; password: string }) {
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
    });
    const { accessToken } = (await response.json()) as { accessToken: string };
    return new this(accessToken);
  }

  private constructor(private accessToken: string) {}

  private request(path: string, init: RequestInit = {}) {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${this.accessToken}` },
    });
  }
  async upload(path: string, content: Buffer, { fileModifiedAt = '2020-01-02T03:04:05.000Z' } = {}) {
    const form = new FormData();
    form.append('assetData', new Blob([new Uint8Array(content)]), path.split('/').at(-1));
    form.append('deviceAssetId', randomUUID());
    form.append('deviceId', 'e2e');
    form.append('fileCreatedAt', '2020-01-01T00:00:00.000Z');
    form.append('fileModifiedAt', fileModifiedAt);
    const response = await this.request('/assets', { method: 'POST', body: form });
    return (await response.json()) as { id: string; status: string };
  }

  async download(path: string, headers: Record<string, string> = {}) {
    const response = await this.request(path, { headers });
    return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
  }

  async downloadArchive(assetIds: string[]) {
    const response = await this.request('/download/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetIds }),
    });
    return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
  }

  async deleteAssets(ids: string[]) {
    await this.request('/assets', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, force: true }),
    });
  }
}
