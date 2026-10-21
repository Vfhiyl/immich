import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Third-party S3 services for contract tests, downloaded once and verified against pinned checksums. Versions are
 * at least two weeks old when pinned; MinIO no longer publishes binaries, so two other independent implementations
 * are used, which also keeps the tests from relying on the behavior of a single one.
 */
export interface Tool {
  name: string;
  version: string;
  url: string;
  sha256: string;
  /** Path of the executable inside the archive */
  executable: string;
}

export const tools = {
  versitygw: {
    name: 'versitygw',
    version: '1.8.0',
    url: 'https://github.com/versity/versitygw/releases/download/v1.8.0/versitygw_v1.8.0_Linux_x86_64.tar.gz',
    sha256: '2ba2c734d10d2c4e651d03182cb4b246656bc735a2f282db7b0b73fba6073467',
    executable: 'versitygw_v1.8.0_Linux_x86_64/versitygw',
  },
  seaweedfs: {
    name: 'seaweedfs',
    version: '4.48',
    url: 'https://github.com/seaweedfs/seaweedfs/releases/download/4.48/linux_amd64.tar.gz',
    sha256: '4a7d108384d044d95212d1342cdda9533fa55842c1c9b41f606ca3c8a9561124',
    executable: 'weed',
  },
} satisfies Record<string, Tool>;

const cacheFolder = () => process.env.IMMICH_TEST_TOOLS_DIR ?? join(homedir(), '.cache', 'immich-test-tools');

const exists = async (path: string) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/** The path of a tool's executable, downloading and verifying it first if needed */
export const getTool = async (tool: Tool): Promise<string> => {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error(`Contract tests need ${tool.name} for linux x64, which is not available for this machine`);
  }

  const folder = join(cacheFolder(), `${tool.name}-${tool.version}`);
  const executable = join(folder, tool.executable);
  if (await exists(executable)) {
    return executable;
  }

  // download into an empty folder of its own and only keep it once the checksum matches
  await mkdir(cacheFolder(), { recursive: true });
  // on the same filesystem as the cache, so that the extracted folder can be moved into place
  const download = await mkdtemp(join(cacheFolder(), `.download-${tool.name}-`));
  try {
    const response = await fetch(tool.url);
    if (!response.ok) {
      throw new Error(`Unable to download ${tool.url}: ${response.status}`);
    }

    const archive = join(download, 'archive.tar.gz');
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
    const sha256 = createHash('sha256')
      .update(await readFile(archive))
      .digest('hex');
    if (sha256 !== tool.sha256) {
      throw new Error(`Checksum of ${tool.url} is ${sha256}, expected ${tool.sha256}`);
    }

    const extracted = join(download, 'extracted');
    await mkdir(extracted);
    execFileSync('tar', ['xzf', archive, '-C', extracted]);
    await rm(folder, { recursive: true, force: true });
    await rename(extracted, folder);
  } finally {
    await rm(download, { recursive: true, force: true });
  }

  return executable;
};
