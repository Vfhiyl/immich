import { mkdirSync, mkdtempDisposableSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdmissionPriority, MemoryAdmission, readAvailableMemory } from 'src/utils/memory-admission.js';

const MiB = 1024 * 1024;

// a machine whose available memory the test sets
const machine = (available: number) => {
  const state = { available };
  return { state, read: () => Promise.resolve(state.available) };
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe(MemoryAdmission.name, () => {
  it('should let operations run together while they fit, and the next when one ends', async () => {
    // 1 GiB available: 1024 - 64 (margin) = 960 MiB for operations
    const sut = new MemoryAdmission(machine(1024 * MiB).read);
    const started: string[] = [];
    const start = (name: string, bytes: number) =>
      sut.acquire(bytes).then((release) => {
        started.push(name);
        return release;
      });

    const a = start('a', 400 * MiB);
    const b = start('b', 400 * MiB);
    void start('c', 400 * MiB);
    await flush();

    expect(started).toEqual(['a', 'b']);
    (await a)();
    await flush();
    expect(started).toEqual(['a', 'b', 'c']);
    (await b)();
  });

  it('should run an operation larger than all the memory when nothing else runs', async () => {
    const sut = new MemoryAdmission(machine(512 * MiB).read);
    const started: string[] = [];

    const small = await sut.acquire(100 * MiB);
    const large = sut.acquire(2048 * MiB).then((release) => {
      started.push('large');
      return release;
    });
    await flush();
    expect(started).toEqual([]);

    small();
    await flush();
    expect(started).toEqual(['large']);
    (await large)();
  });

  it('should start the waiting operations by priority, then in order', async () => {
    const sut = new MemoryAdmission(machine(1024 * MiB).read);
    const started: string[] = [];
    const blocker = await sut.acquire(955 * MiB);
    for (const [name, priority] of [
      ['background 1', AdmissionPriority.Background],
      ['upload', AdmissionPriority.Upload],
      ['background 2', AdmissionPriority.Background],
      ['interactive', AdmissionPriority.Interactive],
    ] as const) {
      void sut.acquire(10 * MiB, priority).then(() => void started.push(name));
    }
    await flush();
    expect(started).toEqual([]);

    blocker();
    await flush();
    expect(started).toEqual(['interactive', 'upload', 'background 1', 'background 2']);
  });

  it('should not let a small operation pass the first that waits', async () => {
    const sut = new MemoryAdmission(machine(1024 * MiB).read);
    const started: string[] = [];
    const running = await sut.acquire(600 * MiB);
    void sut.acquire(500 * MiB).then(() => void started.push('large'));
    void sut.acquire(10 * MiB).then(() => void started.push('small'));
    await flush();

    expect(started).toEqual([]);
    running();
    await flush();
    expect(started).toEqual(['large', 'small']);
  });

  it('should fit fewer while others take memory meanwhile', async () => {
    const memory = machine(1024 * MiB);
    const sut = new MemoryAdmission(memory.read);
    const started: string[] = [];
    const first = await sut.acquire(300 * MiB);
    // machine learning loads a model: 500 MiB fewer available, besides the 300 of the first
    memory.state.available = 224 * MiB;

    void sut.acquire(300 * MiB).then(() => void started.push('second'));
    await flush();
    expect(started).toEqual([]);

    // done, and the model unloaded
    memory.state.available = 1024 * MiB;
    first();
    await flush();
    expect(started).toEqual(['second']);
  });

  it('should release once, however often it is called', async () => {
    const sut = new MemoryAdmission(machine(1024 * MiB).read);
    const release = await sut.acquire(100 * MiB);
    release();
    release();

    expect(sut.state).toMatchObject({ running: 0, granted: 0 });
  });

  it('should release when the operation fails', async () => {
    const sut = new MemoryAdmission(machine(1024 * MiB).read);

    await expect(
      sut.run(100 * MiB, AdmissionPriority.Background, () => Promise.reject(new Error('broken'))),
    ).rejects.toThrow('broken');
    expect(sut.state).toMatchObject({ running: 0, granted: 0 });
  });
});

// a root of files: /proc and /sys as the test makes them
const root = (files: Record<string, string>) => {
  const dir = mkdtempDisposableSync(join(tmpdir(), 'memory-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir.path, path, '..'), { recursive: true });
    writeFileSync(join(dir.path, path), text);
  }
  return dir;
};

describe(readAvailableMemory.name, () => {
  const meminfo = 'MemTotal:       65681380 kB\nMemFree:        17955588 kB\nMemAvailable:    1048576 kB\n';

  it('should read what the machine has available', async () => {
    using dir = root({ 'proc/meminfo': meminfo });
    await expect(readAvailableMemory(dir.path)).resolves.toBe(1024 * MiB);
  });

  it('should read what is left within the limit of a cgroup v2, its inactive file pages given back', async () => {
    using dir = root({
      'proc/meminfo': meminfo,
      'sys/fs/cgroup/memory.max': String(512 * MiB),
      'sys/fs/cgroup/memory.current': String(400 * MiB),
      'sys/fs/cgroup/memory.stat': `anon ${200 * MiB}\nfile ${200 * MiB}\ninactive_file ${100 * MiB}\n`,
    });
    // 512 - (400 - 100)
    await expect(readAvailableMemory(dir.path)).resolves.toBe(212 * MiB);
  });

  it('should read a cgroup v1, and no more than the machine has', async () => {
    using dir = root({
      'proc/meminfo': meminfo,
      'sys/fs/cgroup/memory/memory.limit_in_bytes': String(8192 * MiB),
      'sys/fs/cgroup/memory/memory.usage_in_bytes': String(100 * MiB),
      'sys/fs/cgroup/memory/memory.stat': `total_inactive_file 0\n`,
    });
    await expect(readAvailableMemory(dir.path)).resolves.toBe(1024 * MiB);
  });

  it('should take a cgroup without a limit (max) as the machine', async () => {
    using dir = root({
      'proc/meminfo': meminfo,
      'sys/fs/cgroup/memory.max': 'max',
      'sys/fs/cgroup/memory.current': String(100 * MiB),
    });
    await expect(readAvailableMemory(dir.path)).resolves.toBe(1024 * MiB);
  });
});
