import { readFile } from 'node:fs/promises';
import { freemem } from 'node:os';
import { join } from 'node:path';

const MiB = 1024 * 1024;

/**
 * The memory this process may still take, from what the kernel says is available: within the limit of its cgroup
 * (v2, else v1), less what the cgroup uses but cannot give back (all but its inactive file pages), and no more than
 * the machine has available (MemAvailable, proc_meminfo(5))
 */
export const readAvailableMemory = async (root = '/'): Promise<number> => {
  const read = (path: string) =>
    readFile(join(root, path), 'utf8')
      .then((text) => text.trim())
      .catch(() => null);
  const meminfo = await read('proc/meminfo');
  const machineKb = meminfo ? /^MemAvailable:\s+(\d+) kB$/m.exec(meminfo)?.[1] : undefined;
  const machine = machineKb ? Number(machineKb) * 1024 : freemem();

  for (const [limitFile, usageFile, statFile, inactiveKey] of [
    ['sys/fs/cgroup/memory.max', 'sys/fs/cgroup/memory.current', 'sys/fs/cgroup/memory.stat', 'inactive_file'],
    [
      'sys/fs/cgroup/memory/memory.limit_in_bytes',
      'sys/fs/cgroup/memory/memory.usage_in_bytes',
      'sys/fs/cgroup/memory/memory.stat',
      'total_inactive_file',
    ],
  ]) {
    const [limit, usage, stat] = await Promise.all([read(limitFile), read(usageFile), read(statFile)]);
    if (!limit || !/^\d+$/.test(limit) || !usage || !/^\d+$/.test(usage)) {
      continue;
    }
    const inactive = Number(new RegExp(String.raw`^${inactiveKey} (\d+)$`, 'm').exec(stat ?? '')?.[1] ?? 0);
    const inCgroup = Number(limit) - Math.max(0, Number(usage) - inactive);
    return Math.max(0, Math.min(inCgroup, machine));
  }
  return machine;
};

/** Lower runs first */
export enum AdmissionPriority {
  /** A person waits for it (a person's thumbnail, an edit) */
  Interactive = 0,
  /** The files of a new upload */
  Upload = 1,
  /** Everything else */
  Background = 2,
}

interface Waiter {
  bytes: number;
  priority: AdmissionPriority;
  order: number;
  grant: (release: () => void) => void;
}

/** The memory left free whatever runs: 64 MiB, or a twentieth of what was available when nothing ran, if more */
const marginOf = (available: number) => Math.max(64 * MiB, available / 20);

/**
 * Lets heavy operations (decoding an image, running ffmpeg) of this process start only when the memory they are
 * estimated to take is there, so that several of them do not run the machine out of memory together, whatever the
 * concurrency of the queues they come from: the first of the waiting operations (by priority, then in order) starts
 * when it fits beside those that run; one that never fits starts when none runs.
 *
 * What fits is measured when nothing runs (the memory available then, less a margin), and lowered while some run if
 * others (the api, machine learning) take memory meanwhile; the operations that run are counted by their estimates.
 */
export class MemoryAdmission {
  private waiting: Waiter[] = [];
  private running = 0;
  private granted = 0;
  private budget = 0;
  private order = 0;
  private pumping = false;
  private again = false;

  constructor(private readAvailable: () => Promise<number> = readAvailableMemory) {}

  /** Waits until an operation of an estimated `bytes` may start; call the release when it is done */
  acquire(bytes: number, priority = AdmissionPriority.Background): Promise<() => void> {
    return new Promise((grant) => {
      this.waiting.push({ bytes, priority, order: this.order++, grant });
      void this.pump();
    });
  }

  /** Runs `operation` once admitted */
  async run<T>(bytes: number, priority: AdmissionPriority, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(bytes, priority);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /** The memory available now for one more operation, less the margin */
  async capacity() {
    const available = await this.readAvailable().catch(() => 0);
    return Math.max(0, available - marginOf(available));
  }

  get state() {
    return { running: this.running, granted: this.granted, budget: this.budget, waiting: this.waiting.length };
  }

  /** The waiting operation to start next: by priority, then in order */
  private first() {
    let next = this.waiting[0];
    for (const waiter of this.waiting) {
      if (waiter.priority < next.priority || (waiter.priority === next.priority && waiter.order < next.order)) {
        next = waiter;
      }
    }
    return next;
  }

  private async pump() {
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.again = false;
        while (this.waiting.length > 0) {
          const next = this.first();
          const available = await this.readAvailable().catch(() => 0);
          if (this.running === 0) {
            this.budget = Math.max(0, available - marginOf(available));
          } else {
            // others took memory meanwhile: what this process may have is less
            this.budget = Math.min(this.budget, this.granted + Math.max(0, available - marginOf(available)));
            if (this.granted + next.bytes > this.budget) {
              break;
            }
          }
          this.waiting.splice(this.waiting.indexOf(next), 1);
          this.running++;
          this.granted += next.bytes;
          let released = false;
          next.grant(() => {
            if (released) {
              return;
            }
            released = true;
            this.running--;
            this.granted -= next.bytes;
            void this.pump();
          });
        }
      } while (this.again);
    } finally {
      this.pumping = false;
    }
  }
}
