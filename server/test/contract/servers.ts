import { CreateBucketCommand } from '@aws-sdk/client-s3';
import { ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { S3BackendOptions, createS3Client } from 'src/repositories/s3-blob-store.js';
import { getTool, tools } from 'test/contract/tools.js';

/** How tests reach a running S3 service */
export interface S3Target {
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Services started for the tests are addressed by path; a real service may need virtual hosts */
  addressing?: 'path' | 'virtual-host';
  /** A real service: objects the tests leave are removed afterwards */
  isReal?: boolean;
}

const isFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });

const handedOut = new Set<number>();

/**
 * A port that is free, and so is the port 10000 above it (services such as SeaweedFS derive their gRPC ports that way),
 * that no other service of this run was given; ports picked at random are tried until one is
 */
export const freePort = async (): Promise<number> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    // below 50000, so that ports derived by adding 10000 stay valid
    const port = 10_000 + Math.floor(Math.random() * 40_000);
    if (handedOut.has(port) || handedOut.has(port + 10_000) || handedOut.has(port - 10_000)) {
      continue;
    }
    if ((await isFree(port)) && (await isFree(port + 10_000))) {
      handedOut.add(port);
      return port;
    }
  }
  throw new Error('No free port found');
};

export class RunningService {
  constructor(
    readonly target: S3Target,
    private process: ChildProcess,
    private output: string[],
  ) {}

  get logs() {
    return this.output.join('');
  }

  async stop() {
    this.process.kill('SIGTERM');
    await sleep(500);
    if (this.process.exitCode === null) {
      this.process.kill('SIGKILL');
    }
  }
}

const start = async (
  name: string,
  command: string,
  args: string[],
  target: Omit<S3Target, 'name'>,
): Promise<RunningService> => {
  const output: string[] = [];
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (data) => {
    output.push(data.toString());
  });
  child.stderr?.on('data', (data) => {
    output.push(data.toString());
  });

  const service = new RunningService({ ...target, name }, child, output);
  const client = toClient(service.target);
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) {
      throw new Error(`${name} exited with code ${child.exitCode}:\n${service.logs}`);
    }

    try {
      await client.send(new CreateBucketCommand({ Bucket: target.bucket }));
      return service;
    } catch {
      await sleep(250);
    }
  }

  await service.stop();
  throw new Error(`${name} did not start:\n${service.logs}`);
};

export const toBackendOptions = (target: S3Target, prefix = ''): S3BackendOptions => ({
  endpoint: target.endpoint,
  region: target.region,
  bucket: target.bucket,
  prefix,
  addressing: target.addressing ?? 'path',
  credentials: { type: 'chain' },
});

export const toClient = (target: S3Target, overrides: Parameters<typeof createS3Client>[1] = {}) =>
  createS3Client(toBackendOptions(target), {
    credentials: { accessKeyId: target.accessKeyId, secretAccessKey: target.secretAccessKey },
    ...overrides,
  });

const credentials = () => ({
  accessKeyId: randomBytes(10).toString('hex'),
  secretAccessKey: randomBytes(20).toString('hex'),
});

export const startVersitygw = async (root: string) => {
  const executable = await getTool(tools.versitygw);
  const port = await freePort();
  const { accessKeyId, secretAccessKey } = credentials();
  const data = join(root, 'versitygw');
  await mkdir(data, { recursive: true });
  return start(
    'versitygw',
    executable,
    ['--access', accessKeyId, '--secret', secretAccessKey, '--port', `127.0.0.1:${port}`, 'posix', data],
    { endpoint: `http://127.0.0.1:${port}`, region: 'us-east-1', bucket: 'contract', accessKeyId, secretAccessKey },
  );
};

export const startSeaweedfs = async (root: string) => {
  const executable = await getTool(tools.seaweedfs);
  const { accessKeyId, secretAccessKey } = credentials();
  const data = join(root, 'seaweedfs');
  await mkdir(data, { recursive: true });
  const config = join(root, 'seaweedfs-s3.json');
  await writeFile(
    config,
    JSON.stringify({
      identities: [
        {
          name: 'contract',
          credentials: [{ accessKey: accessKeyId, secretKey: secretAccessKey }],
          actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'],
        },
      ],
    }),
  );

  const ports: Record<string, number> = {};
  for (const name of ['master', 'volume', 'filer', 's3', 'iceberg', 'lance']) {
    ports[name] = await freePort();
  }

  return start(
    'seaweedfs',
    executable,
    [
      'mini',
      `-dir=${data}`,
      `-master.port=${ports.master}`,
      `-volume.port=${ports.volume}`,
      `-filer.port=${ports.filer}`,
      `-s3.port=${ports.s3}`,
      `-s3.port.iceberg=${ports.iceberg}`,
      `-s3.port.lance=${ports.lance}`,
      `-s3.config=${config}`,
      '-admin.ui=false',
      '-webdav=false',
      '-master.telemetry=false',
    ],
    { endpoint: `http://127.0.0.1:${ports.s3}`, region: 'us-east-1', bucket: 'contract', accessKeyId, secretAccessKey },
  );
};
