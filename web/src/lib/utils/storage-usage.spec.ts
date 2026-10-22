import type { StorageBackendUsageDto, StorageDailyUsageDto } from '@immich/sdk';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { budgetShares, rangeOf, summarizeUsage, toUsageRange, usageSeries } from './storage-usage';

const GIB = 1024 ** 3;
const day = (date: string, usage: Partial<StorageDailyUsageDto> = {}): StorageDailyUsageDto => ({
  day: date,
  storedObjects: 0,
  storedBytes: 0,
  stored: {},
  requests: { write: 0, read: 0, delete: 0 },
  bytesSent: 0,
  bytesReceived: 0,
  cost: null,
  ...usage,
});
const backend = (days: StorageDailyUsageDto[]): StorageBackendUsageDto => ({
  backendId: 'originals',
  days,
  purposes: [],
  cost: null,
  budget: null,
});

describe('storage usage', () => {
  it('offers 30, 90 and 365 days, 30 by default', () => {
    expect(toUsageRange('90')).toBe(90);
    expect(toUsageRange('7')).toBe(30);
    expect(toUsageRange(null)).toBe(30);
    expect(rangeOf(30, DateTime.fromISO('2026-10-30', { zone: 'utc' }))).toEqual({
      from: '2026-10-01',
      to: '2026-10-30',
    });
  });

  it('tells what was stored on the last night recorded, and what was asked over the range', () => {
    const summary = summarizeUsage(
      backend([
        day('2026-10-01', { storedObjects: 10, storedBytes: GIB, requests: { write: 5, read: 1, delete: 0 } }),
        day('2026-10-02', { storedObjects: 12, storedBytes: 2 * GIB, bytesReceived: 100 }),
        // requests counted today, not stored yet
        day('2026-10-03', { requests: { write: 1, read: 2, delete: 3 }, bytesSent: 50 }),
      ]),
    );

    expect(summary).toEqual({
      storedBytes: 2 * GIB,
      storedObjects: 12,
      requests: { write: 6, read: 3, delete: 3 },
      bytesSent: 50,
      bytesReceived: 100,
    });
  });

  it('tells how much of the budget is used, and will be at the pace so far', () => {
    expect(budgetShares({ month: '2026-10', currency: 'CNY', amount: 20, monthToDate: 10, projected: 31 })).toEqual({
      spent: 50,
      projected: 155,
      isOver: false,
      willBeOver: true,
    });
    expect(budgetShares({ month: '2026-10', currency: 'CNY', amount: 0, monthToDate: 0, projected: 0 })).toMatchObject({
      spent: 0,
      isOver: false,
    });
  });

  it('charts GiB stored and the cost of each day', () => {
    const [days, stored, costs] = usageSeries(
      backend([
        day('2026-10-01', {
          storedBytes: 1.5 * GIB,
          cost: { currency: 'CNY', storage: 1, requests: 0, egress: 0, total: 1 },
        }),
        day('2026-10-02'),
      ]),
    );

    expect(days).toEqual([1_790_812_800, 1_790_899_200]);
    expect(stored).toEqual([1.5, 0]);
    expect(costs).toEqual([1, null]);
  });
});
