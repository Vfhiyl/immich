import { CreateBucketCommand } from '@aws-sdk/client-s3';
import { ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AzureBlobStore, createAzureContainerClient } from 'src/repositories/azure-blob-store.js';
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
    // below the ports the system hands out for outgoing connections (32768 and up on Linux), which could take one
    // between choosing it and listening on it, also for the derived ports 10000 above
    const port = 10_000 + Math.floor(Math.random() * 12_000);
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

/** How tests reach a running Azure Blob service */
export interface AzureTarget {
  name: string;
  /** The blob service of the account; for Azurite, its address with the account name as the first path segment */
  endpoint: string;
  container: string;
  accountName: string;
  accountKey: string;
  /** A real service: blobs the tests leave are removed afterwards */
  isReal?: boolean;
}

/** An Azure Blob client of a target, with its shared key written to a file as a deployment would */
export const toAzureContainer = (target: AzureTarget, keyFile: string) =>
  createAzureContainerClient({
    endpoint: target.endpoint,
    container: target.container,
    prefix: '',
    credentials: { type: 'sharedKey', accountName: target.accountName, accountKeyFile: keyFile },
  });

/** Azurite, Microsoft's emulator of Azure Storage for local development and tests, with an account of its own */
export const startAzurite = async (root: string) => {
  const port = await freePort();
  const accountName = `contract${randomBytes(4).toString('hex')}`;
  const accountKey = randomBytes(64).toString('base64');
  const data = join(root, 'azurite');
  await mkdir(data, { recursive: true });
  const keyFile = join(root, 'azurite.key');
  await writeFile(keyFile, accountKey);

  const output: string[] = [];
  const executable = join(import.meta.dirname, '../../node_modules/.bin/azurite-blob');
  const child = spawn(
    executable,
    [
      '--blobHost',
      '127.0.0.1',
      '--blobPort',
      String(port),
      '--location',
      data,
      '--skipApiVersionCheck',
      '--disableTelemetry',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AZURITE_ACCOUNTS: `${accountName}:${accountKey}` } },
  );
  child.stdout?.on('data', (data) => {
    output.push(data.toString());
  });
  child.stderr?.on('data', (data) => {
    output.push(data.toString());
  });

  const target: AzureTarget = {
    name: 'azurite',
    endpoint: `http://127.0.0.1:${port}/${accountName}`,
    container: 'contract',
    accountName,
    accountKey,
  };
  const stop = async () => {
    child.kill('SIGTERM');
    await sleep(500);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
  };
  const container = toAzureContainer(target, keyFile);
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) {
      throw new Error(`Azurite exited with code ${child.exitCode}:\n${output.join('')}`);
    }
    try {
      await container.createIfNotExists();
      return { target, stop };
    } catch {
      await sleep(250);
    }
  }
  await stop();
  throw new Error(`Azurite did not start:\n${output.join('')}`);
};

/** A store on a target, below a prefix of its own */
export const toAzureStore = (target: AzureTarget, keyFile: string, prefix: string) =>
  new AzureBlobStore(toAzureContainer(target, keyFile), prefix);
