import { QueueName } from 'src/enum.js';
import {
  BackoffLevel,
  BackoffState,
  NO_WINDOW,
  ResourceSample,
  WINDOW_CALM_MS,
  WINDOW_MS,
  assessSample,
  nextBackoff,
  nextWindow,
} from 'src/utils/ml-backoff.js';

const GiB = 1024 ** 3;
const sample = (share: number, pressure: ResourceSample['pressure'] = null): ResourceSample => ({
  memory: { used: share * 8 * GiB, limit: 8 * GiB, source: 'cgroup2' },
  pressure,
});
const run = (state: BackoffState, ...samples: Array<ResourceSample | null>) => {
  let current = state;
  for (const next of samples) {
    current = nextBackoff(current, next);
  }
  return current;
};
const normal: BackoffState = { level: BackoffLevel.Normal, calm: 0 };

describe('backoff of machine learning jobs', () => {
  describe(assessSample.name, () => {
    it('should ask for less by the share of memory in use and by the time tasks waited for memory', () => {
      expect(assessSample(sample(0.5))).toBe('calm');
      expect(assessSample(sample(0.8))).toBe('hold');
      expect(assessSample(sample(0.86))).toBe(BackoffLevel.Reduced);
      expect(assessSample(sample(0.96))).toBe(BackoffLevel.Paused);
      expect(assessSample(sample(0.5, { some: 12, full: 0 }))).toBe(BackoffLevel.Reduced);
      expect(assessSample(sample(0.5, { some: 30, full: 6 }))).toBe(BackoffLevel.Paused);
      expect(assessSample(sample(0.5, { some: 3, full: 0 }))).toBe('hold');
    });

    it('should go by pressure alone when the memory is not known', () => {
      expect(assessSample({ memory: null, pressure: { some: 12, full: 0 } })).toBe(BackoffLevel.Reduced);
      expect(assessSample({ memory: null, pressure: null })).toBe('calm');
    });
  });

  describe(nextBackoff.name, () => {
    it('should give way at once', () => {
      expect(run(normal, sample(0.9))).toEqual({ level: BackoffLevel.Reduced, calm: 0 });
      expect(run(normal, sample(0.97))).toEqual({ level: BackoffLevel.Paused, calm: 0 });
      // a lighter sample does not undo a pause
      expect(run(normal, sample(0.97), sample(0.9)).level).toBe(BackoffLevel.Paused);
    });

    it('should come back one step at a time, each after three calm checks in a row', () => {
      const paused = run(normal, sample(0.97));

      expect(run(paused, sample(0.5), sample(0.5)).level).toBe(BackoffLevel.Paused);
      expect(run(paused, sample(0.5), sample(0.5), sample(0.5)).level).toBe(BackoffLevel.Reduced);
      expect(run(paused, ...Array.from({ length: 6 }, () => sample(0.5))).level).toBe(BackoffLevel.Normal);
    });

    it('should not come back while the memory stays between the thresholds', () => {
      const reduced = run(normal, sample(0.9));

      expect(run(reduced, sample(0.5), sample(0.5), sample(0.8), sample(0.5), sample(0.5)).level).toBe(
        BackoffLevel.Reduced,
      );
    });

    it('should change nothing without an answer', () => {
      const paused = run(normal, sample(0.97));
      expect(run(paused, null, null, null, null)).toEqual(paused);
      expect(run(normal, null)).toEqual(normal);
    });
  });
});

describe(nextWindow.name, () => {
  const all = { [QueueName.SmartSearch]: 5, [QueueName.FaceDetection]: 5, [QueueName.Ocr]: 5 };

  it('should run one task at a time once the service unloads a model for another, each for a while in turn', () => {
    let state = nextWindow(NO_WINDOW, { evictions: 1, waiting: all, now: 0 });
    expect(state.active).toBe(QueueName.SmartSearch);

    state = nextWindow(state, { evictions: 0, waiting: all, now: WINDOW_MS - 1 });
    expect(state.active).toBe(QueueName.SmartSearch);
    state = nextWindow(state, { evictions: 0, waiting: all, now: WINDOW_MS });
    expect(state).toMatchObject({ active: QueueName.FaceDetection, since: WINDOW_MS });
  });

  it('should go on to the next task with jobs as soon as the one that runs has none', () => {
    const state = nextWindow(
      { active: QueueName.SmartSearch, since: 0, evictedAt: 0 },
      {
        evictions: 0,
        waiting: { [QueueName.SmartSearch]: 0, [QueueName.FaceDetection]: 0, [QueueName.Ocr]: 3 },
        now: 1000,
      },
    );
    expect(state.active).toBe(QueueName.Ocr);
  });

  it('should run all tasks again once the service unloaded no model for a while', () => {
    const state = nextWindow(
      { active: QueueName.Ocr, since: 0, evictedAt: 0 },
      { evictions: 0, waiting: all, now: WINDOW_CALM_MS },
    );
    expect(state).toEqual(NO_WINDOW);
  });
});
