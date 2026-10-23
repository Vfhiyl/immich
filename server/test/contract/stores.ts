import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobStore } from 'src/repositories/blob-store.js';
import { LocalBlobStore } from 'src/repositories/local-blob-store.js';
import { S3BlobStore } from 'src/repositories/s3-blob-store.js';
import { AzureTarget, S3Target, toAzureStore, toClient } from 'test/contract/servers.js';

const removeAll = async (store: BlobStore) => {
  const listed = await Array.fromAsync(store.list());
  const keys = listed.map(({ key }) => key);
  for (let index = 0; index < keys.length; index += store.limits.maxDeleteBatch) {
    await store.deleteMany(keys.slice(index, index + store.limits.maxDeleteBatch));
  }
};

/** Every store the contract tests run against: a local folder and each S3 service the global setup started */
export const targets: S3Target[] = JSON.parse(process.env.CONTRACT_S3_TARGETS ?? '[]');
/** And each Azure Blob service */
export const azureTargets: AzureTarget[] = JSON.parse(process.env.CONTRACT_AZURE_TARGETS ?? '[]');

export const stores: Array<{
  name: string;
  /** See `BlobStoreLimits.tracksUploads` */
  tracksUploads: boolean;
  create: () => Promise<{ store: BlobStore; cleanup: () => Promise<void> }>;
}> = [
  {
    name: 'local',
    tracksUploads: true,
    create: async () => {
      const root = await mkdtemp(join(tmpdir(), 'immich-contract-local-'));
      return { store: new LocalBlobStore(root), cleanup: () => rm(root, { recursive: true, force: true }) };
    },
  },
  ...targets.map((target) => ({
    name: target.name,
    tracksUploads: true,
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
  ...azureTargets.map((target) => ({
    name: target.name,
    tracksUploads: false,
    create: async () => {
      const directory = await mkdtemp(join(tmpdir(), 'immich-contract-azure-'));
      const keyFile = join(directory, 'account.key');
      writeFileSync(keyFile, target.accountKey);
      // a prefix of its own, so that every run starts empty
      const store = toAzureStore(target, keyFile, `contract-${randomUUID()}/`);
      return {
        store,
        cleanup: async () => {
          if (target.isReal) {
            await removeAll(store);
          }
          await rm(directory, { recursive: true, force: true });
        },
      };
    },
  })),
];
