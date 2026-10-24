import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import {
  RESOURCE_REQUIREMENTS,
  ResourceCheckLevel,
  checkLevel,
  readCpuLimit,
  readDisk,
  readMemoryLimit,
} from 'src/utils/server-resources.js';

describe('resources of the server', () => {
  let root: string;
  const write = async (files: Record<string, string>) => {
    for (const [name, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, name)), { recursive: true });
      await writeFile(join(root, name), content);
    }
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'immich-resources-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('should take the memory limit of the container when it is below the machine', async () => {
    await write({ 'sys/fs/cgroup/memory.max': '2147483648\n' });
    await expect(readMemoryLimit(root)).resolves.toEqual({ bytes: 2_147_483_648, source: 'cgroup' });
  });

  it('should take the memory of the machine without a limit, also of cgroup v1', async () => {
    await expect(readMemoryLimit(root)).resolves.toEqual({ bytes: totalmem(), source: 'machine' });
    await write({ 'sys/fs/cgroup/memory.max': 'max\n' });
    await expect(readMemoryLimit(root)).resolves.toEqual({ bytes: totalmem(), source: 'machine' });
    await write({ 'sys/fs/cgroup/memory/memory.limit_in_bytes': '1073741824\n' });
    await expect(readMemoryLimit(root)).resolves.toEqual({ bytes: 1_073_741_824, source: 'cgroup' });
  });

  it('should take the CPU quota of the container when it is below the cores', async () => {
    await expect(readCpuLimit(root)).resolves.toEqual({ cores: availableParallelism(), source: 'machine' });
    await write({ 'sys/fs/cgroup/cpu.max': 'max 100000\n' });
    await expect(readCpuLimit(root)).resolves.toEqual({ cores: availableParallelism(), source: 'machine' });
    await write({ 'sys/fs/cgroup/cpu.max': '50000 100000\n' });
    await expect(readCpuLimit(root)).resolves.toEqual({ cores: 0.5, source: 'cgroup' });
  });

  it('should tell the free space of the disk of a folder', async () => {
    const disk = await readDisk(root);
    expect(disk.path).toBe(root);
    expect(disk.free).toBeGreaterThan(0);
    expect(disk.total).toBeGreaterThanOrEqual(disk.free);
  });

  it('should compare against the documented minimum and recommendation', () => {
    const { memory, disk } = RESOURCE_REQUIREMENTS;
    expect(checkLevel(4 * 1024 ** 3, memory)).toBe(ResourceCheckLevel.BelowMinimum);
    expect(checkLevel(6 * 1024 ** 3, memory)).toBe(ResourceCheckLevel.BelowRecommended);
    expect(checkLevel(16 * 1024 ** 3, memory)).toBe(ResourceCheckLevel.Ok);
    expect(checkLevel(100 * 1024 ** 3, disk)).toBe(ResourceCheckLevel.Ok);
  });
});
