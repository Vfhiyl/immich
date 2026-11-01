/** A time the background work ran out of memory: what was killed, and how many times within a couple of minutes */
export interface MemoryKill {
  at: string;
  what: string[];
  count: number;
}

/** What the server keeps of the times it ran out of memory (system metadata) */
export interface MemoryKillState {
  kills: MemoryKill[];
  /** The processes killed for memory so far as the kernel counted them when last read (see readOomKills) */
  oomKills?: number;
  /** When the admin was last told */
  notifiedAt?: string;
}

const DAY = 24 * 60 * 60 * 1000;
/** Kills within this of each other are the same time (the kernel's count, the job that failed, the worker that died) */
const SAME_TIME_MS = 2 * 60 * 1000;
const KEPT_DAYS = 30;
/** The admin is told at most this often */
export const MEMORY_KILL_NOTIFY_EVERY_MS = DAY;

/** The state with one more kill of `what` at `now` (kills of the last 30 days are kept) */
export const addMemoryKill = (state: MemoryKillState, what: string, now: Date, count = 1): MemoryKillState => {
  const kills = state.kills.filter((kill) => now.getTime() - Date.parse(kill.at) < KEPT_DAYS * DAY);
  const last = kills.at(-1);
  if (last && now.getTime() - Date.parse(last.at) < SAME_TIME_MS) {
    const merged = {
      at: last.at,
      what: last.what.includes(what) ? last.what : [...last.what, what],
      count: last.count + count,
    };
    return { ...state, kills: [...kills.slice(0, -1), merged] };
  }
  return { ...state, kills: [...kills, { at: now.toISOString(), what: [what], count }] };
};

/** The times it ran out of memory in the last `days` days */
export const countMemoryKills = (state: MemoryKillState | null, now: Date, days = 7) =>
  (state?.kills ?? []).filter((kill) => now.getTime() - Date.parse(kill.at) < days * DAY).length;

/**
 * Whether a job failed because a program it ran was killed (SIGKILL) by something else than this server: as the
 * kernel does when memory runs out. (A program the server stops as stuck fails with "made no progress")
 */
export const isKilledProgram = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return /\bSIGKILL\b/.test(message) && !message.includes('made no progress');
};
