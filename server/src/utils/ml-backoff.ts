import { QueueName } from 'src/enum.js';

/** What the machine learning service tells of its memory (`GET /resources`); null where it cannot tell */
export interface ResourceSample {
  memory: { used: number; limit: number; source: string } | null;
  pressure: { some: number; full: number } | null;
  /** The models it unloaded in the last minute to load others (as it has too little memory for all of them) */
  models?: { evictions: number } | null;
}

export enum BackoffLevel {
  /** The jobs of machine learning run as configured */
  Normal = 'normal',
  /** One at a time */
  Reduced = 'reduced',
  /** Not at all, until the memory is free again */
  Paused = 'paused',
}

/**
 * When the jobs give way: the share of the memory limit in use, and the share of time tasks waited for memory over
 * the last 10 seconds (PSI, in percent; `some`: at least one task, `full`: all of them). Engineering values, fixed here
 */
export const BACKOFF_THRESHOLDS = {
  pause: { memory: 0.95, full: 5 },
  reduce: { memory: 0.85, some: 10 },
  calm: { memory: 0.75, some: 2 },
  /** The checks in a row that must be calm before the jobs take one step back up */
  calmChecks: 3,
};

/** The queues whose jobs send photos to the machine learning service (recognizing faces only queries the database) */
export const BACKOFF_QUEUES = [QueueName.SmartSearch, QueueName.FaceDetection, QueueName.Ocr] as const;

export interface BackoffState {
  level: BackoffLevel;
  /** The calm checks in a row so far */
  calm: number;
}

const ORDER = [BackoffLevel.Normal, BackoffLevel.Reduced, BackoffLevel.Paused];

/** What one sample asks for: a level at least, or calm enough to step back, or neither (hold) */
export const assessSample = ({ memory, pressure }: ResourceSample): BackoffLevel | 'calm' | 'hold' => {
  const share = memory && memory.limit > 0 ? memory.used / memory.limit : 0;
  const { pause, reduce, calm } = BACKOFF_THRESHOLDS;
  if (share >= pause.memory || (pressure?.full ?? 0) >= pause.full) {
    return BackoffLevel.Paused;
  }
  if (share >= reduce.memory || (pressure?.some ?? 0) >= reduce.some) {
    return BackoffLevel.Reduced;
  }
  if (share < calm.memory && (pressure?.some ?? 0) < calm.some) {
    return 'calm';
  }
  return 'hold';
};

/**
 * The next state after a sample: the jobs give way at once, and come back one step at a time after enough calm
 * checks in a row (so that they do not swing back and forth at a threshold). Without a sample (the service did not
 * answer) nothing changes.
 */
export const nextBackoff = (state: BackoffState, sample: ResourceSample | null): BackoffState => {
  if (!sample) {
    return state;
  }
  const wanted = assessSample(sample);
  if (wanted === 'hold') {
    return { level: state.level, calm: 0 };
  }
  if (wanted === 'calm') {
    const calm = state.calm + 1;
    if (state.level === BackoffLevel.Normal || calm < BACKOFF_THRESHOLDS.calmChecks) {
      return { level: state.level, calm: state.level === BackoffLevel.Normal ? 0 : calm };
    }
    return { level: ORDER[ORDER.indexOf(state.level) - 1], calm: 0 };
  }
  return { level: ORDER[Math.max(ORDER.indexOf(state.level), ORDER.indexOf(wanted))], calm: 0 };
};

/**
 * With too little memory for all of its models, the machine learning service unloads one to load another: the server
 * then runs one task of machine learning at a time (smart search, faces, text recognition), each for WINDOW_MS while
 * it has jobs, so that a model is loaded once for many photos rather than once for each. It does so until the service
 * unloaded none for WINDOW_CALM_MS
 */
export const WINDOW_MS = 2 * 60 * 1000;
export const WINDOW_CALM_MS = 10 * 60 * 1000;

export interface WindowState {
  /** The queue that runs, the others waiting; null: all run */
  active: QueueName | null;
  /** Since when it runs */
  since: number;
  /** When the service last unloaded a model for another */
  evictedAt: number;
}

export const NO_WINDOW: WindowState = { active: null, since: 0, evictedAt: 0 };

/** The next state after a check: `evictions` the service told, `waiting` the jobs waiting in each queue */
export const nextWindow = (
  state: WindowState,
  { evictions, waiting, now }: { evictions: number; waiting: Partial<Record<QueueName, number>>; now: number },
): WindowState => {
  const evictedAt = evictions > 0 ? now : state.evictedAt;
  if (now - evictedAt >= WINDOW_CALM_MS) {
    return NO_WINDOW;
  }
  const busy = new Set(BACKOFF_QUEUES.filter((queue) => (waiting[queue] ?? 0) > 0));
  const current = state.active;
  const stays = current !== null && (waiting[current] ?? 0) > 0 && now - state.since < WINDOW_MS;
  if (stays) {
    return { ...state, evictedAt };
  }
  // the next queue with jobs, in turn; or the current one if no other has any
  const queues: QueueName[] = [...BACKOFF_QUEUES];
  const start = current === null ? 0 : queues.indexOf(current) + 1;
  const order = [...queues.slice(start), ...queues.slice(0, start)];
  const next = order.find((queue) => busy.has(queue as (typeof BACKOFF_QUEUES)[number])) ?? current ?? queues[0];
  return { active: next, since: next === current ? state.since : now, evictedAt };
};
