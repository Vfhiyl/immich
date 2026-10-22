import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3Target, startSeaweedfs, startVersitygw } from 'test/contract/servers.js';

/**
 * A real service to run the contract tests against as well, e.g. the bucket a deployment will use, from a JSON file
 * named by IMMICH_CONTRACT_REAL_S3: name, endpoint, region, bucket, addressing, accessKeyId and secretAccessKeyFile.
 * The tests write below a prefix of their own and remove what they wrote. Not run unless asked for.
 */
const readRealTarget = async (): Promise<S3Target | undefined> => {
  const path = process.env.IMMICH_CONTRACT_REAL_S3;
  if (!path) {
    return undefined;
  }
  const { secretAccessKeyFile, ...target } = JSON.parse(await readFile(path, 'utf8'));
  const secret = await readFile(secretAccessKeyFile, 'utf8');
  const secretAccessKey = secret.trim();
  return { addressing: 'virtual-host', ...target, secretAccessKey, isReal: true };
};

/** Start the S3 services that blob store contract tests run against; tests find them in CONTRACT_S3_TARGETS */
export default async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'immich-contract-'));
  const real = await readRealTarget();
  // only the real service, if it is the one asked for
  const services =
    real && process.env.IMMICH_CONTRACT_REAL_S3_ONLY === 'true'
      ? []
      : await Promise.all([startVersitygw(root), startSeaweedfs(root)]);
  const targets = [...services.map(({ target }) => target), ...(real ? [real] : [])];
  process.env.CONTRACT_S3_TARGETS = JSON.stringify(targets);

  return async () => {
    await Promise.all(services.map((service) => service.stop()));
    await rm(root, { recursive: true, force: true });
  };
}
