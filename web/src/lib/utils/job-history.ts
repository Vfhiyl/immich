import type { JobHistoryBucketDto } from '@immich/sdk';
import { DateTime } from 'luxon';

/** The failures listed on a page */
export const FAILURES_PAGE_SIZE = 50;

/** The ranges the history of jobs offers: since today began (here), the last days, or all that is kept */
export const JOB_HISTORY_RANGES = ['today', '3d', '7d', '30d', '365d', 'all'] as const;
export type JobHistoryRange = (typeof JOB_HISTORY_RANGES)[number];

export const toJobHistoryRange = (value: string | null): JobHistoryRange =>
  JOB_HISTORY_RANGES.find((range) => range === value) ?? '7d';

/** From when a range goes (undefined: all) */
export const sinceOf = (range: JobHistoryRange, now: DateTime = DateTime.local()): string | undefined => {
  switch (range) {
    case 'today': {
      return now.startOf('day').toUTC().toISO()!;
    }
    case 'all': {
      return undefined;
    }
    default: {
      return now
        .minus({ days: Number.parseInt(range) })
        .toUTC()
        .toISO()!;
    }
  }
};

/** The share of the jobs that ran (succeeded or failed) that failed, in percent, one decimal; null without runs */
export const failureRate = ({ succeeded, failed }: { succeeded: number; failed: number }) =>
  succeeded + failed > 0 ? Math.round((failed / (succeeded + failed)) * 1000) / 10 : null;

/** The series of the chart: the start of each bucket (as seconds), the jobs that succeeded, and those that failed */
export const historySeries = (series: JobHistoryBucketDto[]): [number[], number[], number[]] => [
  series.map(({ start }) => DateTime.fromISO(start).toSeconds()),
  series.map(({ succeeded }) => succeeded),
  series.map(({ failed }) => failed),
];
