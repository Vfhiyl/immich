import { NotificationLevel, SystemMetadataKey } from 'src/enum.js';
import { JobHistoryService, getHistoryUnit } from 'src/services/job-history.service.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-11-02T12:00:00Z');
const totals = (jobName: string, succeeded: number, failed: number) => ({
  jobName,
  queueName: 'q',
  succeeded,
  failed,
  retried: 0,
});

describe(JobHistoryService.name, () => {
  let sut: JobHistoryService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(JobHistoryService));
    mocks.jobHistory.getSeries.mockResolvedValue([]);
    mocks.jobHistory.getReasons.mockResolvedValue([]);
    mocks.user.getAdmin.mockResolvedValue(UserFactory.create({ isAdmin: true }));
    mocks.notification.create.mockResolvedValue({ id: 'n', createdAt: now } as never);
  });

  // the last 24 hours, then the 31 days to now
  const history = (day: ReturnType<typeof totals>[], month: ReturnType<typeof totals>[]) =>
    mocks.jobHistory.getTotals.mockImplementation((since?: Date) =>
      Promise.resolve(since && now.getTime() - since.getTime() <= DAY ? day : month),
    );

  it('should choose hours, days or months by the span asked for', () => {
    expect(getHistoryUnit(new Date(now.getTime() - DAY), now)).toBe('hour');
    expect(getHistoryUnit(new Date(now.getTime() - 3 * DAY), now)).toBe('hour');
    expect(getHistoryUnit(new Date(now.getTime() - 30 * DAY), now)).toBe('day');
    expect(getHistoryUnit(new Date(now.getTime() - 365 * DAY), now)).toBe('month');
    expect(getHistoryUnit(undefined, now)).toBe('month');
  });

  it('should tell the jobs that fail far more often than usual in the last 24 hours', async () => {
    history(
      [totals('AssetGenerateThumbnails', 60, 40), totals('SmartSearch', 70, 30), totals('Ocr', 5, 5)],
      [totals('AssetGenerateThumbnails', 1050, 50), totals('SmartSearch', 770, 330), totals('Ocr', 5, 5)],
    );

    const { alerts, totals: all } = await sut.getHistory({ since: new Date(now.getTime() - DAY).toISOString() }, now);

    // thumbnails: 40% against 1% before; smart search fails as often as before; text recognition ran too little
    expect(alerts).toEqual([{ jobName: 'AssetGenerateThumbnails', runs: 100, failed: 40, usualRate: 0.01 }]);
    expect(all).toEqual({ succeeded: 135, failed: 75, retried: 0 });
  });

  it('should notify the admin of such jobs at most once a day for each', async () => {
    history([totals('AssetGenerateThumbnails', 60, 40)], [totals('AssetGenerateThumbnails', 60, 40)]);
    let notified: Record<string, string> | null = null;
    mocks.systemMetadata.get.mockImplementation(() => Promise.resolve(notified));
    mocks.systemMetadata.set.mockImplementation((_, value) => {
      notified = value as Record<string, string>;
      return Promise.resolve();
    });

    await sut.check(now);
    await sut.check(new Date(now.getTime() + 60 * 60 * 1000));
    await sut.check(new Date(now.getTime() + DAY));

    expect(mocks.notification.create).toHaveBeenCalledTimes(2);
    expect(mocks.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        level: NotificationLevel.Warning,
        description: expect.stringContaining('AssetGenerateThumbnails: 40 of 100 failed in the last 24 hours'),
      }),
    );
    expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.JobHistoryAlerts, expect.any(Object));
    expect(mocks.jobHistory.removeOldFailures).toHaveBeenCalledWith(365, 200_000);
  });

  it('should list a page of the failures', async () => {
    mocks.jobHistory.countFailures.mockResolvedValue(120);
    mocks.jobHistory.getFailures.mockResolvedValue([]);

    await expect(sut.getFailures({ jobName: 'Ocr', page: 3, size: 50 })).resolves.toEqual({ total: 120, items: [] });

    expect(mocks.jobHistory.getFailures).toHaveBeenCalledWith({ jobName: 'Ocr', since: undefined }, 50, 100);
  });
});
