import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobStore } from 'src/repositories/blob-store.js';
import { LocalBlobStore } from 'src/repositories/local-blob-store.js';
import { S3BlobStore } from 'src/repositories/s3-blob-store.js';
import { S3Target, toClient } from 'test/contract/servers.js';

const removeAll = async (store: BlobStore) => {
  const listed = await Array.fromAsync(store.list());
  const keys = listed.map(({ key }) => key);
  for (let index = 0; index < keys.length; index += store.limits.maxDeleteBatch) {
    await store.deleteMany(keys.slice(index, index + store.limits.maxDeleteBatch));
  }
};

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
    create: () => {
      // a prefix of its own, so that every run starts empty
      const store = new S3BlobStore(toClient(target), target.bucket, `contract-${randomUUID()}/`);
      return Promise.resolve({
        store,
        // a real bucket is not thrown away after the tests like the services started for them
        cleanup: target.isReal ? () => removeAll(store) : () => Promise.resolve(),
      });
    },
  })),
];
