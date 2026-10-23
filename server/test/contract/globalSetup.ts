import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AzureTarget, S3Target, startAzurite, startSeaweedfs, startVersitygw } from 'test/contract/servers.js';

/**
 * A real S3 service to run the contract tests against as well, e.g. the bucket a deployment will use, from a JSON file
 * named by IMMICH_CONTRACT_REAL_S3: name, endpoint, region, bucket, addressing, accessKeyId and secretAccessKeyFile.
 * The tests write below a prefix of their own and remove what they wrote. Not run unless asked for.
 */
const readRealS3Target = async (): Promise<S3Target | undefined> => {
  const path = process.env.IMMICH_CONTRACT_REAL_S3;
  if (!path) {
    return undefined;
  }
  const { secretAccessKeyFile, ...target } = JSON.parse(await readFile(path, 'utf8'));
  const secret = await readFile(secretAccessKeyFile, 'utf8');
  const secretAccessKey = secret.trim();
  return { addressing: 'virtual-host', ...target, secretAccessKey, isReal: true };
};

/** The same for a container of Azure Blob Storage, named by IMMICH_CONTRACT_REAL_AZURE: name, endpoint, container,
 * accountName and accountKeyFile */
const readRealAzureTarget = async (): Promise<AzureTarget | undefined> => {
  const path = process.env.IMMICH_CONTRACT_REAL_AZURE;
  if (!path) {
    return undefined;
  }
  const { accountKeyFile, ...target } = JSON.parse(await readFile(path, 'utf8'));
  const accountKey = await readFile(accountKeyFile, 'utf8');
  return { ...target, accountKey: accountKey.trim(), isReal: true };
};

/**
 * Start the services that blob store contract tests run against; tests find them in CONTRACT_S3_TARGETS and
 * CONTRACT_AZURE_TARGETS. With IMMICH_CONTRACT_REAL_ONLY, only the real services asked for.
 */
export default async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'immich-contract-'));
  const realS3 = await readRealS3Target();
  const realAzure = await readRealAzureTarget();
  const onlyReal = process.env.IMMICH_CONTRACT_REAL_ONLY === 'true';
  const services = onlyReal ? [] : await Promise.all([startVersitygw(root), startSeaweedfs(root)]);
  const azurite = onlyReal ? undefined : await startAzurite(root);
  process.env.CONTRACT_S3_TARGETS = JSON.stringify([
    ...services.map(({ target }) => target),
    ...(realS3 ? [realS3] : []),
  ]);
  process.env.CONTRACT_AZURE_TARGETS = JSON.stringify([
    ...(azurite ? [azurite.target] : []),
    ...(realAzure ? [realAzure] : []),
  ]);

  return async () => {
    await Promise.all(services.map((service) => service.stop()));
    await azurite?.stop();
    await rm(root, { recursive: true, force: true });
  };
}
