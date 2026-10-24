import { QueueName } from 'src/enum.js';

/** What the machine learning service tells of its memory (`GET /resources`); null where it cannot tell */
export interface ResourceSample {
  memory: { used: number; limit: number; source: string } | null;
  pressure: { some: number; full: number } | null;
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
