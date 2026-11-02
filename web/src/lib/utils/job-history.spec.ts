import { DateTime } from 'luxon';
import { describe, expect, test } from 'vitest';
import { failureRate, historySeries, sinceOf, toJobHistoryRange } from './job-history';

describe('the history of jobs', () => {
  const now = DateTime.fromISO('2026-11-02T15:30:00', { zone: 'Asia/Shanghai' });

  test('goes from the start of today here, or so many days back, or all', () => {
    expect(sinceOf('today', now)).toBe('2026-11-01T16:00:00.000Z');
    expect(sinceOf('3d', now)).toBe('2026-10-30T07:30:00.000Z');
    expect(sinceOf('365d', now)).toBe('2025-11-02T07:30:00.000Z');
    expect(sinceOf('all', now)).toBeUndefined();
  });

  test('takes an unknown range as a week', () => {
    expect(toJobHistoryRange('30d')).toBe('30d');
    expect(toJobHistoryRange('2y')).toBe('7d');
    expect(toJobHistoryRange(null)).toBe('7d');
  });

  test('tells the share of the jobs that failed', () => {
    expect(failureRate({ succeeded: 2, failed: 1 })).toBe(33.3);
    expect(failureRate({ succeeded: 0, failed: 0 })).toBeNull();
  });

  test('makes the series of the chart', () => {
    expect(
      historySeries([
        { start: '2026-11-02T00:00:00.000Z', succeeded: 5, failed: 1, retried: 0 },
        { start: '2026-11-02T01:00:00.000Z', succeeded: 3, failed: 0, retried: 2 },
      ]),
    ).toEqual([
      [1_793_577_600, 1_793_581_200],
      [5, 3],
      [1, 0],
    ]);
  });
});
