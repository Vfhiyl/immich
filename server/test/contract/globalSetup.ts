import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSeaweedfs, startVersitygw } from 'test/contract/servers.js';

/** Start the S3 services that blob store contract tests run against; tests find them in CONTRACT_S3_TARGETS */
export default async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'immich-contract-'));
  const services = await Promise.all([startVersitygw(root), startSeaweedfs(root)]);
  process.env.CONTRACT_S3_TARGETS = JSON.stringify(services.map(({ target }) => target));

  return async () => {
    await Promise.all(services.map((service) => service.stop()));
    await rm(root, { recursive: true, force: true });
  };
}
