import { writeFileSync } from 'node:fs';

/** A background worker that stayed up this long is healthy again: its earlier crashes no longer delay a restart */
export const WORKER_HEALTHY_AFTER_MS = 5 * 60 * 1000;

const WORKER_RESTART_MIN_MS = 1000;
const WORKER_RESTART_MAX_MS = 60 * 1000;

/** How long to wait before starting a background worker again, after it crashed `crashes` times in a row */
export const getWorkerRestartDelay = (crashes: number) =>
  Math.min(WORKER_RESTART_MIN_MS * 2 ** Math.max(crashes - 1, 0), WORKER_RESTART_MAX_MS);

/**
 * Added to the badness of the background worker, and of the programs it runs (ffmpeg, exiftool, ...), which inherit it.
 * When memory runs out, the kernel kills the background work, not the api (see proc_pid_oom_score_adj(5))
 */
export const BACKGROUND_OOM_SCORE_ADJ = 500;

/**
 * Makes this process the first to be killed when memory runs out. A process may always raise its own oom_score_adj; where
 * there is no such file (not Linux) or it cannot be written, nothing changes
 */
export const preferAsOomVictim = () => {
  try {
    writeFileSync('/proc/self/oom_score_adj', String(BACKGROUND_OOM_SCORE_ADJ));
    return true;
  } catch {
    return false;
  }
};
