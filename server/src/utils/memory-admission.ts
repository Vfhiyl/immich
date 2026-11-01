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
  /** When it began to wait, the times before included (a job put back and taken again) */
  since: number;
  grant: (release: () => void) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** An operation that waited this long is not passed by others any more: the memory is kept for it (see acquire) */
export const ADMISSION_RESERVE_AFTER_MS = 10 * 60 * 1000;

/** It waited for memory longer than it was to (`waitLimitMs`), and was not admitted */
export class AdmissionTimeout extends Error {
  constructor(public since: number) {
    super('No memory for it yet');
    this.name = 'AdmissionTimeout';
  }
}

/** The memory left free whatever runs: 64 MiB, or a twentieth of what was available when nothing ran, if more */
const marginOf = (available: number) => Math.max(64 * MiB, available / 20);

/**
 * Lets heavy operations (decoding an image, running ffmpeg) of this process start only when the memory they are
 * estimated to take is there, so that several of them do not run the machine out of memory together, whatever the
 * concurrency of the queues they come from.
 *
 * The waiting operations start by priority, then in order, each when it fits beside those that run; one that does not
 * fit does not hold back those after it that do (as backfilling schedulers do). One that waited for
 * ADMISSION_RESERVE_AFTER_MS is not passed any more: no other starts until it does, when it fits or when nothing else
 * runs. An operation larger than all the memory starts when nothing else runs.
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

  /**
   * Waits until an operation of an estimated `bytes` may start; call the release when it is done. With `waitLimitMs`,
   * gives up after waiting so long (AdmissionTimeout), unless it waited ADMISSION_RESERVE_AFTER_MS since `since`
   */
  acquire(
    bytes: number,
    priority = AdmissionPriority.Background,
    { since = Date.now(), waitLimitMs }: { since?: number; waitLimitMs?: number } = {},
  ): Promise<() => void> {
    return new Promise((grant, reject) => {
      const waiter: Waiter = { bytes, priority, order: this.order++, since, grant };
      if (waitLimitMs !== undefined) {
        waiter.timer = setTimeout(() => {
          const index = this.waiting.indexOf(waiter);
          if (index === -1 || this.isReserved(waiter)) {
            return;
          }
          this.waiting.splice(index, 1);
          reject(new AdmissionTimeout(since));
          // it may have held back the others
          void this.pump();
        }, waitLimitMs);
      }
      this.waiting.push(waiter);
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

  private isReserved(waiter: Waiter) {
    return Date.now() - waiter.since >= ADMISSION_RESERVE_AFTER_MS;
  }

  /** The waiting operations in the order they start: by priority, then in order */
  private ordered() {
    return this.waiting.toSorted((a, b) => a.priority - b.priority || a.order - b.order);
  }

  private start(waiter: Waiter) {
    clearTimeout(waiter.timer);
    this.waiting.splice(this.waiting.indexOf(waiter), 1);
    this.running++;
    this.granted += waiter.bytes;
    let released = false;
    waiter.grant(() => {
      if (released) {
        return;
      }
      released = true;
      this.running--;
      this.granted -= waiter.bytes;
      void this.pump();
    });
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
          const available = await this.readAvailable().catch(() => 0);
          const ordered = this.ordered();
          // one that waited long enough goes first, before the others
          const reserved = ordered.find((waiter) => this.isReserved(waiter));
          if (this.running === 0) {
            this.budget = Math.max(0, available - marginOf(available));
            this.start(reserved ?? ordered[0]);
            continue;
          }
          // others took memory meanwhile: what this process may have is less
          this.budget = Math.min(this.budget, this.granted + Math.max(0, available - marginOf(available)));
          const fits = (waiter: Waiter) => this.granted + waiter.bytes <= this.budget;
          const next = reserved ? (fits(reserved) ? reserved : undefined) : ordered.find((waiter) => fits(waiter));
          if (!next) {
            break;
          }
          this.start(next);
        }
      } while (this.again);
    } finally {
      this.pumping = false;
    }
  }
}
