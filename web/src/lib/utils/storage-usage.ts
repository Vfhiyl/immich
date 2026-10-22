import type { StorageBackendUsageDto, StorageBudgetDto } from '@immich/sdk';
import { DateTime } from 'luxon';

/** The ranges the usage page offers, in days up to today (UTC) */
export const USAGE_RANGES = [30, 90, 365] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

export const toUsageRange = (value: string | null): UsageRange =>
  USAGE_RANGES.find((days) => String(days) === value) ?? USAGE_RANGES[0];

export const rangeOf = (days: number, today: DateTime = DateTime.utc()) => ({
  from: today.minus({ days: days - 1 }).toISODate()!,
  to: today.toISODate()!,
});

/** What a backend stores (as recorded on the last night of the range) and what was asked of it over the range */
export const summarizeUsage = ({ days }: StorageBackendUsageDto) => {
  const lastRecorded = days.findLast((day) => day.storedObjects > 0 || day.storedBytes > 0);
  return {
    storedBytes: lastRecorded?.storedBytes ?? 0,
    storedObjects: lastRecorded?.storedObjects ?? 0,
    requests: {
      write: days.reduce((total, day) => total + day.requests.write, 0),
      read: days.reduce((total, day) => total + day.requests.read, 0),
      delete: days.reduce((total, day) => total + day.requests.delete, 0),
    },
    bytesSent: days.reduce((total, day) => total + day.bytesSent, 0),
    bytesReceived: days.reduce((total, day) => total + day.bytesReceived, 0),
  };
};

/** How much of the budget the month used so far and will use at that pace, in percent */
export const budgetShares = ({ amount, monthToDate, projected }: StorageBudgetDto) => ({
  spent: amount > 0 ? Math.round((monthToDate / amount) * 100) : monthToDate > 0 ? Infinity : 0,
  projected: amount > 0 ? Math.round((projected / amount) * 100) : projected > 0 ? Infinity : 0,
  isOver: monthToDate > amount,
  willBeOver: projected > amount,
});

/** The series of the chart: the days (as seconds), GiB stored, and the estimated cost of each day if there are prices */
export const usageSeries = ({ days }: StorageBackendUsageDto): [number[], number[], (number | null)[]] => [
  days.map(({ day }) => DateTime.fromISO(day, { zone: 'utc' }).toSeconds()),
  days.map(({ storedBytes }) => Math.round((storedBytes / 1024 ** 3) * 100) / 100),
  days.map(({ cost }) => cost?.total ?? null),
];
