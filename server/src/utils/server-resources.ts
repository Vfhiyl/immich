import { readFile, statfs } from 'node:fs/promises';
import { availableParallelism, totalmem } from 'node:os';
import { join } from 'node:path';

/** What upstream documents as needed (docs/docs/install/requirements.md), and the local disk storage backends need */
export const RESOURCE_REQUIREMENTS = {
  memory: { minimum: 6 * 1024 ** 3, recommended: 8 * 1024 ** 3 },
  cpus: { minimum: 2, recommended: 4 },
  /** For temporary files, the processing copy of uploads and the cache of thumbnails (storage-backends.md) */
  disk: { minimum: 20 * 1024 ** 3 },
};

export enum ResourceCheckLevel {
  Ok = 'ok',
  BelowRecommended = 'below_recommended',
  BelowMinimum = 'below_minimum',
}

const read = async (path: string) => {
  try {
    const text = await readFile(path, 'utf8');
    return text.trim();
  } catch {
    return null;
  }
};

/** The memory the server has: of the machine, or less when its container has a limit (cgroup v2, else v1) */
export const readMemoryLimit = async (root = '/') => {
  const machine = totalmem();
  const v2 = await read(join(root, 'sys/fs/cgroup/memory.max'));
  const v1 = await read(join(root, 'sys/fs/cgroup/memory/memory.limit_in_bytes'));
  const limit = [v2, v1].map((value) => (value && /^\d+$/.test(value) ? Number(value) : null)).find(Boolean);
  return limit && limit < machine ? { bytes: limit, source: 'cgroup' } : { bytes: machine, source: 'machine' };
};

/**
 * The swap the server may use: of the machine (SwapTotal, proc_meminfo(5)), or less when its container has a limit
 * (cgroup v2 memory.swap.max). Swap lets a machine of little memory run: the background work goes on, slower
 */
export const readSwap = async (root = '/') => {
  const meminfo = await read(join(root, 'proc/meminfo'));
  const kb = meminfo ? /^SwapTotal:\s+(\d+) kB$/m.exec(meminfo)?.[1] : undefined;
  const machine = kb ? Number(kb) * 1024 : 0;
  const max = await read(join(root, 'sys/fs/cgroup/memory.swap.max'));
  const limit = max && /^\d+$/.test(max) ? Number(max) : null;
  return limit !== null && limit < machine ? { bytes: limit, source: 'cgroup' } : { bytes: machine, source: 'machine' };
};

/**
 * The processes the kernel killed as memory ran out so far: of the container of the server (cgroup v2 memory.events,
 * `oom_kill`), else of the machine (/proc/vmstat); null where it cannot tell
 */
export const readOomKills = async (root = '/') => {
  for (const [path, pattern] of [
    ['sys/fs/cgroup/memory.events', /^oom_kill (\d+)$/m],
    ['proc/vmstat', /^oom_kill (\d+)$/m],
  ] as const) {
    const text = await read(join(root, path));
    const count = text ? pattern.exec(text)?.[1] : undefined;
    if (count !== undefined) {
      return Number(count);
    }
  }
  return null;
};

/** The cores the server may use: those it may run on, or fewer when its container has a quota (cgroup v2 cpu.max) */
export const readCpuLimit = async (root = '/') => {
  const cores = availableParallelism();
  const cpuMax = await read(join(root, 'sys/fs/cgroup/cpu.max'));
  const [quota, period] = cpuMax?.split(' ') ?? [];
  const limit = quota && quota !== 'max' && period ? Number(quota) / Number(period) : null;
  return limit && limit < cores ? { cores: limit, source: 'cgroup' } : { cores, source: 'machine' };
};

export const readDisk = async (path: string) => {
  const { bavail, blocks, bsize } = await statfs(path);
  return { path, free: bavail * bsize, total: blocks * bsize };
};

export const checkLevel = (value: number, { minimum, recommended }: { minimum: number; recommended?: number }) =>
  value < minimum
    ? ResourceCheckLevel.BelowMinimum
    : recommended !== undefined && value < recommended
      ? ResourceCheckLevel.BelowRecommended
      : ResourceCheckLevel.Ok;
