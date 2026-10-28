import { ContainerClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import { ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';

/**
 * Runs a real Immich server (API and microservices workers) as a local process, so that storage backend scenarios
 * can be tested end to end, including restarts with another configuration. It needs PostgreSQL with the vector
 * extension and Redis, which `src/specs/storage-backends/setup.ts` provides, and a built server (`server/dist`).
 */

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../server');
const webBuild = resolve(serverRoot, '../web/build');
export const testAssetDir = resolve(dirname(fileURLToPath(import.meta.url)), '../test-assets');

const postgresBase = process.env.E2E_STORAGE_POSTGRES_URL ?? 'postgres://postgres:postgres@localhost:5432';
export const redisPort = Number(process.env.E2E_STORAGE_REDIS_PORT ?? 6391);
const port = Number(process.env.E2E_STORAGE_PORT ?? 2290);
const execFileAsync = promisify(execFile);
export const baseUrl = `http://localhost:${port}/api`;
export const serverPort = port;

export interface LocalBackend {
  id: string;
  role: 'originals' | 'derived' | 'backup' | 'replica';
  /** For a replica, the roles whose backends it copies */
  replicaOf?: Array<'originals' | 'backup'>;
  /** Store the backend's files on an S3 service, below this prefix, instead of a local folder */
  s3?: { service: S3Service; prefix: string };
  /** Or on an Azure Blob service */
  azure?: { service: AzureService; prefix: string };
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

    // below the ports the system hands out for outgoing connections (32768 and up on Linux)
    const port = 22_000 + Math.floor(Math.random() * 10_000);
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

/** Azurite, Microsoft's emulator of Azure Storage, with an account of its own (installed with the server) */
export class AzureService {
  static async start(environment: TestEnvironment) {
    const root = join(environment.root, 'azurite');
    await mkdir(root, { recursive: true });
    const accountName = `immich${randomUUID().slice(0, 8)}`;
    const accountKeyFile = join(environment.root, 'azure-key');
    const accountKey = randomBytes(64).toString('base64');
    await writeFile(accountKeyFile, accountKey);

    const port = 22_000 + Math.floor(Math.random() * 10_000);
    const child = spawn(
      join(serverRoot, 'node_modules/.bin/azurite-blob'),
      [
        '--blobHost',
        '127.0.0.1',
        '--blobPort',
        String(port),
        '--location',
        root,
        '--skipApiVersionCheck',
        '--disableTelemetry',
      ],
      { stdio: 'ignore', env: { ...process.env, AZURITE_ACCOUNTS: `${accountName}:${accountKey}` } },
    );
    const service = new this(child, `http://127.0.0.1:${port}/${accountName}`, 'immich', accountName, accountKeyFile);
    // the container is made by whoever sets up a deployment, as a bucket is
    const container = new ContainerClient(
      `${service.endpoint}/${service.container}`,
      new StorageSharedKeyCredential(accountName, accountKey),
    );
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await container.createIfNotExists();
        return service;
      } catch {
        await sleep(100);
      }
    }
    child.kill();
    throw new Error('The Azure service did not start');
  }

  private constructor(
    private process: ChildProcess,
    readonly endpoint: string,
    readonly container: string,
    readonly accountName: string,
    readonly accountKeyFile: string,
  ) {}

  stop() {
    this.process.kill();
  }
}

export const sha1 = (value: Buffer) => createHash('sha1').update(value).digest('hex');

/** A directory with everything one test environment writes: media location, backends and configuration */
export class TestEnvironment {
  /**
   * With `web`, the server serves the built web app (`web/build`), for tests in a browser. Without `configFile`, the
   * system settings are in the database and can be changed in the web app (call `Api.configure` after the start).
   */
  static async create({ web = false, configFile = true } = {}) {
    const environment = new this(await mkdtemp(join(tmpdir(), 'immich-e2e-storage-')), configFile);
    await environment.writeBuildData(web);
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

  private constructor(
    readonly root: string,
    readonly usesConfigFile = true,
  ) {}

  /** The server imports reverse geocoding data on startup; one placeholder row of each file is enough */
  private async writeBuildData(web: boolean) {
    const geodata = join(this.root, 'build', 'geodata');
    await mkdir(geodata, { recursive: true });
    if (web) {
      try {
        await access(join(webBuild, 'index.html'));
      } catch {
        throw new Error('The web app is not built; run `pnpm --filter immich-web build` first');
      }
      await symlink(webBuild, join(this.root, 'build', 'www'));
    } else {
      await mkdir(join(this.root, 'build', 'www'), { recursive: true });
    }
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

  /**
   * What a new server that replaces a lost one has: an empty database and media location, but the same storage
   * configuration, master key file and storage. The server must be stopped.
   */
  async loseServer() {
    await withDatabase('postgres', async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${this.database} WITH (FORCE)`);
      await client.query(`CREATE DATABASE ${this.database}`);
    });
    await rm(this.mediaLocation, { recursive: true, force: true });
    await mkdir(this.mediaLocation, { recursive: true });
  }

  get mediaLocation() {
    return join(this.root, 'media');
  }

  /** Where administrators export the originals to (IMMICH_EXPORT_LOCATION) */
  get exportLocation() {
    return join(this.root, 'app-export');
  }

  get configFile() {
    return join(this.root, 'immich-config.json');
  }

  get databaseUrl() {
    return `${postgresBase}/${this.database}`;
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

  /**
   * Write the storage backend configuration, with a new master key unless `keepMasterKey`; with `keyCommand`, the keys
   * come from a command that prints the key file (as one would print what a key management service decrypts)
   */
  async writeBackends(backends: LocalBackend[], { keepMasterKey = false, keyCommand = false } = {}) {
    const lines = [];
    if (backends.some(({ s3, azure, encrypted }) => encrypted ?? !!(s3 || azure))) {
      if (!keepMasterKey) {
        await rm(this.masterKeyFile, { force: true });
        await runEncryptionTool(['generate-key', this.masterKeyFile]);
      }
      lines.push(
        'encryption:',
        keyCommand
          ? `  masterKeyCommand: ["/bin/cat", "${this.masterKeyFile}"]`
          : `  masterKeyFile: ${this.masterKeyFile}`,
      );
    }

    lines.push('backends:');
    for (const { id, role, replicaOf, s3, azure, encrypted } of backends) {
      lines.push(`  - id: ${id}`, `    role: ${role}`);
      if (replicaOf) {
        lines.push(`    replicaOf: [${replicaOf.join(', ')}]`);
      }
      if (encrypted !== undefined) {
        lines.push(`    encrypted: ${encrypted}`);
      }
      if (azure) {
        const { service, prefix } = azure;
        lines.push(
          '    driver: azure',
          `    endpoint: ${service.endpoint}`,
          `    container: ${service.container}`,
          `    prefix: ${prefix}`,
          '    credentials:',
          '      type: sharedKey',
          `      accountName: ${service.accountName}`,
          `      accountKeyFile: ${service.accountKeyFile}`,
        );
      } else if (s3) {
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

  /**
   * Files stored on a backend, without the probes of the startup check and what writes that were cut off left (stopping
   * the server can cut one off; they are removed after two days)
   */
  async listBackend(id: string) {
    const entries = await readdirIfExists(this.backendRoot(id));
    return entries
      .filter((name) => name !== '.immich-probe' && !name.endsWith('.immich-tmp'))
      .toSorted((a, b) => a.localeCompare(b));
  }

  listStaging() {
    return readdirIfExists(join(this.mediaLocation, '.immich-staging'));
  }

  /** Local copies of stored files kept for processing, or with `cache` cached derived files, of every backend */
  async listLocalCopies({ cache = false } = {}) {
    const root = join(this.mediaLocation, cache ? '.immich-cache' : '.immich-copies');
    const backends = await readdirIfExists(root);
    const copies = await Promise.all(backends.map((backend) => readdirIfExists(join(root, backend))));
    return copies.flat();
  }

  /** Move the registered deletions of files into the past, as if their deletion delay had passed */
  async makeDeletionsDue() {
    await this.query(
      `update storage_deletion set "notBefore" = now() - interval '1 day', "createdAt" = now() - interval '10 years'`,
    );
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

const serverEnv = (environment: TestEnvironment, { backends = true } = {}) => ({
  ...process.env,
  DB_URL: `${postgresBase}/${environment.database}`,
  DB_VECTOR_EXTENSION: process.env.DB_VECTOR_EXTENSION ?? 'pgvector',
  REDIS_HOSTNAME: 'localhost',
  REDIS_PORT: String(redisPort),
  IMMICH_PORT: String(port),
  IMMICH_MEDIA_LOCATION: environment.mediaLocation,
  ...(environment.usesConfigFile && { IMMICH_CONFIG_FILE: environment.configFile }),
  IMMICH_EXPORT_LOCATION: environment.exportLocation,
  IMMICH_BUILD_DATA: join(environment.root, 'build'),
  IMMICH_LOG_LEVEL: 'log',
  NO_COLOR: 'true',
  ...(backends && { IMMICH_STORAGE_BACKENDS: environment.backendsFile }),
});

/** Run the `immich-encryption` tool, with an empty environment since it must not need anything else */
export const runEncryptionTool = async (args: string[]) => {
  const { stdout } = await execFileAsync(join(serverRoot, 'bin', 'immich-encryption'), args, {
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
  });
  return stdout;
};

/** Run `immich-export`, which needs no running server; it exits with 1 when some originals could not be exported */
export const runExportTool = async (args: string[]) => {
  try {
    const { stdout, stderr } = await execFileAsync(join(serverRoot, 'bin', 'immich-export'), args, {
      env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const { code, stdout, stderr } = error as { code: number; stdout: string; stderr: string };
    return { code, stdout, stderr };
  }
};

/** The resumable upload client of the mobile app, run with Dart outside the app (E2E_DART, by default `dart`) */
export const runMobileUploadClient = async (args: string[]) => {
  const mobileRoot = resolve(serverRoot, '../mobile');
  try {
    const { stdout } = await execFileAsync(
      process.env.E2E_DART ?? 'dart',
      ['run', 'tool/resumable_upload.dart', ...args],
      { cwd: mobileRoot, env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` } },
    );
    return JSON.parse(stdout.trim().split('\n').at(-1)!) as { result: string; id?: string; message?: string };
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: string; stderr?: string };
    throw new Error(`The mobile upload client failed:\n${stdout}\n${stderr}`, { cause: error });
  }
};

/** The CLI (built in packages/cli/dist), with its configuration in `configDirectory` */
export const runCli = async (args: string[], { configDirectory, key }: { configDirectory: string; key: string }) => {
  const cli = resolve(serverRoot, '../packages/cli/dist/index.js');
  try {
    const { stdout } = await execFileAsync(process.execPath, [cli, ...args], {
      env: {
        PATH: process.env.PATH,
        IMMICH_INSTANCE_URL: baseUrl,
        IMMICH_API_KEY: key,
        IMMICH_CONFIG_DIR: configDirectory,
      },
    });
    return stdout;
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: string; stderr?: string };
    throw new Error(`The CLI failed:\n${stdout}\n${stderr}`, { cause: error });
  }
};

/** A running server; `start` resolves once both workers are ready, or rejects with the output if it exits */
export class ImmichServer {
  /** With `maintenance`, the server is expected to come up in maintenance mode (e.g. for its storage setup) */
  static async start(
    environment: TestEnvironment,
    { backends = true, maintenance = false }: { backends?: boolean; maintenance?: boolean } = {},
  ) {
    const child = spawn(process.execPath, ['dist/main.js'], {
      cwd: serverRoot,
      // a process group, so that the workers are stopped with the server
      detached: true,
      env: serverEnv(environment, { backends }),
    });

    const server = new this(child);
    await server.waitUntilReady(maintenance);
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

  private async waitUntilReady(maintenance: boolean) {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (this.exited !== undefined) {
        throw new Error(`The server exited with code ${this.exited}:\n${this.logs}`);
      }

      if (
        maintenance
          ? await isInMaintenanceMode()
          : this.logs.includes('Immich Microservices is running') && (await isApiUp())
      ) {
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

  /** The process of a worker of the server (`api`, `microservices`, which name their processes so), if it runs */
  async workerPid(name: string) {
    const pids = this.process.pid ? await descendantsOf(this.process.pid) : [];
    for (const pid of pids) {
      try {
        const commandLine = await readFile(`/proc/${pid}/cmdline`, 'utf8');
        if (commandLine.startsWith(`immich-${name}`)) {
          return pid;
        }
      } catch {
        // the process ended meanwhile
      }
    }
  }

  async stop() {
    // processes of the server in groups of their own (exiftool) are not stopped with its group, and would stay
    const descendants = this.process.pid ? await descendantsOf(this.process.pid) : [];
    if (this.exited === undefined && this.process.pid) {
      process.kill(-this.process.pid, 'SIGTERM');
    }
    for (let attempt = 0; attempt < 100 && this.exited === undefined; attempt++) {
      await sleep(100);
    }
    for (const pid of descendants) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone already
      }
    }
  }
}

/** The processes below a process, from /proc (Linux) */
const descendantsOf = async (root: number) => {
  const parents = new Map<number, number>();
  for (const entry of await readdirIfExists('/proc')) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    try {
      const stat = await readFile(`/proc/${entry}/stat`, 'utf8');
      // pid (comm) state ppid …, where comm may hold spaces and parentheses
      const [, ppid] = stat.slice(stat.lastIndexOf(')') + 2).split(' ', 2);
      parents.set(Number(entry), Number(ppid));
    } catch {
      // the process ended meanwhile
    }
  }
  const found: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    for (const [child, parent] of parents) {
      if (parent === pid) {
        found.push(child);
        queue.push(child);
      }
    }
  }
  return found;
};

const isInMaintenanceMode = async () => {
  try {
    const response = await fetch(`${baseUrl}/server/config`);
    return response.ok && ((await response.json()) as { maintenanceMode?: boolean }).maintenanceMode === true;
  } catch {
    return false;
  }
};

const isApiUp = async () => {
  try {
    const response = await fetch(`${baseUrl}/server/ping`);
    return response.ok;
  } catch {
    return false;
  }
};

/**
 * A machine learning service as the server sees it (`POST /predict`, `GET /ping`), answering smart search with an
 * embedding of the files it pretends to have (`fingerprint`, which a test changes as if the files were replaced),
 * and telling those files the way this fork's service does; it finds no faces and no text
 */
export class FakeMachineLearning {
  static async start() {
    const service = new this();
    await new Promise<void>((resolve) => service.server.listen(0, '127.0.0.1', resolve));
    return service;
  }

  private held = new Map<string, Promise<void>>();
  private server: Server = createServer((request, response) => {
    void this.handle(request.url ?? '', request, response);
  });
  fingerprint = 'a'.repeat(64);
  /** What `GET /resources` answers, as this fork's service does; null answers 404, as upstream's does */
  resources: { memory: { used: number; limit: number; source: string } | null; pressure: null } | null = {
    memory: { used: 1024 ** 3, limit: 8 * 1024 ** 3, source: 'cgroup2' },
    pressure: null,
  };
  /** The models asked for, by task and type, e.g. `clip/visual ViT-B-32__openai` */
  readonly requests: string[] = [];

  private constructor() {}

  private async handle(
    url: string,
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
  ) {
    if (url === '/ping') {
      response.end('pong');
      return;
    }
    if (url === '/resources') {
      response.statusCode = this.resources ? 200 : 404;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(this.resources ?? {}));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }
    const form = await new Response(Buffer.concat(chunks), {
      headers: { 'Content-Type': request.headers['content-type'] ?? '' },
    }).formData();
    const entries = JSON.parse(String(form.get('entries'))) as Record<string, Record<string, { modelName: string }>>;
    const answer: Record<string, unknown> = { imageHeight: 100, imageWidth: 100, models: {} };
    for (const [task, models] of Object.entries(entries)) {
      const described: Record<string, unknown> = {};
      for (const [type, { modelName }] of Object.entries(models)) {
        this.requests.push(`${task}/${type} ${modelName}`);
        if (type === 'visual') {
          await this.held.get(modelName);
        }
        described[type] = { name: modelName, fingerprint: this.fingerprint, format: 'onnx' };
      }
      (answer.models as Record<string, unknown>)[task] = described;
      const { modelName } = Object.values(models)[0];
      // the dimension of the model of that name (see the server's list of CLIP models), in one direction per set of
      // files
      const dimensions = modelName.includes('ViT-L-14') ? 768 : 512;
      answer[task] =
        task === 'clip'
          ? JSON.stringify(
              Array.from({ length: dimensions }, (_, index) =>
                index === this.fingerprint.codePointAt(0)! % dimensions ? 1 : 0.01,
              ),
            )
          : task === 'ocr'
            ? { text: [], box: [], boxScore: [], textScore: [] }
            : [];
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(answer));
  }

  /** Answers for photos with a model only once `release` is called, to look at what happens meanwhile */
  hold(modelName: string) {
    let release!: () => void;
    this.held.set(modelName, new Promise<void>((resolve) => (release = resolve)));
    return () => {
      this.held.delete(modelName);
      release();
    };
  }

  get url() {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop() {
    await new Promise((resolve) => this.server.close(resolve));
  }
}

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

  private constructor(readonly accessToken: string) {}

  private request(path: string, init: RequestInit = {}) {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${this.accessToken}` },
    });
  }

  /** The access token, for requests that fetch cannot make (like ones that are cut off on purpose) */
  get token() {
    return this.accessToken;
  }

  /** A request as it is, with authentication */
  raw(path: string, init: RequestInit = {}) {
    return this.request(path, init);
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

  /** Resolves once no queue of the server has jobs waiting or running (the work of uploads is done) */
  async waitForIdleQueues({ timeout = 60_000 } = {}) {
    await eventually(
      async () => {
        const { body } = await this.json<Array<{ name: string; statistics: Record<string, number> }>>('/queues');
        const busy = body.filter(({ statistics: { active, waiting } }) => active + waiting > 0);
        if (busy.length > 0) {
          throw new Error(`Queues still busy: ${busy.map(({ name }) => name).join(', ')}`);
        }
      },
      { timeout },
    );
  }

  /** A JSON request, resolving with the status and the parsed body, if any */
  async json<T = unknown>(path: string, { method = 'GET', body }: { method?: string; body?: unknown } = {}) {
    const response = await this.request(path, {
      method,
      ...(body !== undefined && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T };
  }

  /** The system settings of a server without a configuration file, as the tests' configuration file has them */
  async configure() {
    const { body } = await this.json<Record<string, Record<string, unknown>>>('/system-config');
    await this.json('/system-config', {
      method: 'PUT',
      body: {
        ...body,
        machineLearning: { ...body.machineLearning, enabled: false },
        newVersionCheck: { ...body.newVersionCheck, enabled: false },
        reverseGeocoding: { ...body.reverseGeocoding, enabled: false },
      },
    });
  }

  async deleteAssets(ids: string[]) {
    await this.request('/assets', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, force: true }),
    });
  }
}
