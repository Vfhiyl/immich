import { readFile } from 'node:fs/promises';

/** A program that made no progress for this long is taken to be stuck, however slow the machine (see watchProgress) */
export const STALL_MS = 10 * 60 * 1000;
const CHECK_MS = 30 * 1000;

/**
 * The bytes a process read and wrote so far (rchar, wchar of /proc/<pid>/io, proc_pid_io(5): what it passed to read()
 * and write() and their kind, from files and pipes alike); null where it cannot be read (not Linux)
 */
export const readProcessIo = async (pid: number): Promise<number | null> => {
  try {
    const text = await readFile(`/proc/${pid}/io`, 'utf8');
    const read = /^rchar: (\d+)$/m.exec(text)?.[1];
    const written = /^wchar: (\d+)$/m.exec(text)?.[1];
    return read === undefined || written === undefined ? null : Number(read) + Number(written);
  } catch {
    return null;
  }
};

/**
 * Watches a program that works through its input (ffmpeg, immich-thumbnail) for progress rather than for the time it
 * takes, which grows with the input and the slowness of the machine: as long as it reads or writes (its input, its
 * output, what it reports) or `beat` is called, it goes on; when nothing of that happens for `stallMs` it is stuck
 * (a decoder in a loop, a storage that does not answer), and `onStall` is called once. Returns what stops watching
 */
export const watchProgress = (
  pid: number | undefined,
  onStall: () => void,
  {
    stallMs = STALL_MS,
    checkMs = CHECK_MS,
    readIo = readProcessIo,
  }: { stallMs?: number; checkMs?: number; readIo?: (pid: number) => Promise<number | null> } = {},
) => {
  let last: number | null = null;
  let progressedAt = Date.now();
  let stopped = false;
  // where neither its reads and writes can be seen nor a beat comes, nothing tells it is stuck: it is not stopped
  let observable = false;
  const timer = setInterval(() => {
    void (async () => {
      const io = pid === undefined ? null : await readIo(pid);
      if (stopped) {
        return;
      }
      if (io !== null && io !== last) {
        observable = true;
        last = io;
        progressedAt = Date.now();
      }
      if (!(observable && Date.now() - progressedAt >= stallMs)) {
        return;
      }

      stop();
      onStall();
    })();
  }, checkMs);
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  return {
    /** Something showed progress (a line of ffmpeg's progress) */
    beat: () => {
      observable = true;
      progressedAt = Date.now();
    },
    stop,
  };
};
