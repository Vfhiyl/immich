import { BackoffLevel, BackoffState, ResourceSample, assessSample, nextBackoff } from 'src/utils/ml-backoff.js';

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
