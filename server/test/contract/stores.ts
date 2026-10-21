import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobStore } from 'src/repositories/blob-store.js';
import { LocalBlobStore } from 'src/repositories/local-blob-store.js';
import { S3BlobStore } from 'src/repositories/s3-blob-store.js';
import { S3Target, toClient } from 'test/contract/servers.js';

/** Every store the contract tests run against: a local folder and each S3 service the global setup started */
export const targets: S3Target[] = JSON.parse(process.env.CONTRACT_S3_TARGETS ?? '[]');

export const stores: Array<{
  name: string;
  create: () => Promise<{ store: BlobStore; cleanup: () => Promise<void> }>;
}> = [
  {
    name: 'local',
    create: async () => {
      const root = await mkdtemp(join(tmpdir(), 'immich-contract-local-'));
      return { store: new LocalBlobStore(root), cleanup: () => rm(root, { recursive: true, force: true }) };
    },
  },
  ...targets.map((target) => ({
    name: target.name,
    create: () =>
      Promise.resolve({
        // a prefix of its own, so that every run starts empty
        store: new S3BlobStore(toClient(target), target.bucket, `contract-${randomUUID()}/`),
        cleanup: () => Promise.resolve(),
      }),
  })),
];
