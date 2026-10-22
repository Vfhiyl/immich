import {
  JobStatus,
  NotificationLevel,
  StorageBackendDriver,
  StorageBackendRole,
  StorageUsageCategory,
  SystemMetadataKey,
} from 'src/enum.js';
import { StoragePriceClass, StorageUsageService, toPriceClass } from 'src/services/storage-usage.service.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const GIB = 1024 ** 3;

const requests = (day: string, operation: string, purpose: string, count: number, bytesReceived = 0) => ({
  day,
  backendId: 'originals',
  operation,
  purpose,
  requests: count,
  bytesSent: 0,
  bytesReceived,
});

describe(StorageUsageService.name, () => {
  let sut: StorageUsageService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(StorageUsageService));
    mocks.storageBackend.configure([
      {
        id: 'originals',
        driver: StorageBackendDriver.Local,
        role: StorageBackendRole.Originals,
        root: '/o',
        encrypted: false,
      },
    ]);
  });

  it('should charge reads, deletes and everything else as services do', () => {
    expect(toPriceClass('GetObject')).toBe(StoragePriceClass.Read);
    expect(toPriceClass('HeadObject')).toBe(StoragePriceClass.Read);
    expect(toPriceClass('DeleteObjects')).toBe(StoragePriceClass.Delete);
    expect(toPriceClass('AbortMultipartUpload')).toBe(StoragePriceClass.Delete);
    expect(toPriceClass('UploadPart')).toBe(StoragePriceClass.Write);
    expect(toPriceClass('ListObjectsV2')).toBe(StoragePriceClass.Write);
  });

  it('should write the counted requests to the database', async () => {
    mocks.storageBackend.drainRequestUsage.mockReturnValue([requests('2026-10-22', 'GetObject', 'api', 3)]);
    await sut.flush();
    expect(mocks.storageUsage.addRequests).toHaveBeenCalledWith([requests('2026-10-22', 'GetObject', 'api', 3)]);

    // estimates: counts that cannot be written are not worth failing for
    mocks.storageUsage.addRequests.mockRejectedValue(new Error('database is gone'));
    await expect(sut.flush()).resolves.toBeUndefined();
  });

  it('should record what is stored every night, and forget usage after three years', async () => {
    await expect(sut.handleSnapshot()).resolves.toBe(JobStatus.Success);
    expect(mocks.storageUsage.recordStored).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    expect(mocks.storageUsage.removeBefore).toHaveBeenCalledOnce();

    mocks.storageBackend.configure([]);
    await expect(sut.handleSnapshot()).resolves.toBe(JobStatus.Skipped);
  });

  it('should tell the usage per day and purpose, with costs by the prices in the settings', async () => {
    mocks.systemMetadata.get.mockResolvedValue({
      storagePricing: {
        backends: [
          {
            backendId: 'originals',
            currency: 'CNY',
            storageGbMonth: 3,
            writeRequests10k: 0.1,
            readRequests10k: 0.01,
            deleteRequests10k: 0,
            egressGb: 0.5,
          },
        ],
      },
    });
    mocks.storageUsage.getRequests.mockResolvedValue([
      requests('2026-10-21', 'PutObject', 'api', 10_000),
      requests('2026-10-21', 'GetObject', 'AssetGenerateThumbnails', 20_000, 2 * GIB),
      requests('2026-10-22', 'DeleteObjects', 'StorageDeletionRun', 5),
    ]);
    mocks.storageUsage.getStored.mockResolvedValue([
      { day: '2026-10-21', backendId: 'originals', category: StorageUsageCategory.Files, objects: 10, bytes: 10 * GIB },
    ]);

    const { from, to, backends } = await sut.getUsage({ from: '2026-10-21', to: '2026-10-22' });

    expect({ from, to }).toEqual({ from: '2026-10-21', to: '2026-10-22' });
    expect(backends).toHaveLength(1);
    const [{ days, purposes, cost }] = backends;
    expect(days[0]).toEqual({
      day: '2026-10-21',
      storedObjects: 10,
      storedBytes: 10 * GIB,
      stored: { files: { objects: 10, bytes: 10 * GIB } },
      requests: { write: 10_000, read: 20_000, delete: 0 },
      bytesSent: 0,
      bytesReceived: 2 * GIB,
      // 10 GiB for a day at 3 a month, 0.1 + 0.02 for the requests, 2 GiB read at 0.5
      cost: { currency: 'CNY', storage: 1, requests: 0.12, egress: 1, total: 2.12 },
    });
    expect(days[1]).toMatchObject({ day: '2026-10-22', storedBytes: 0, requests: { delete: 5 } });
    expect(purposes.map(({ purpose }) => purpose)).toEqual(['api', 'AssetGenerateThumbnails', 'StorageDeletionRun']);
    expect(purposes[1].cost).toMatchObject({ requests: 0.02, egress: 1, total: 1.02 });
    expect(cost).toEqual({ currency: 'CNY', storage: 1, requests: 0.12, egress: 1, total: 2.12 });
  });

  it('should leave out costs without prices, and reject a range that ends before it starts', async () => {
    mocks.storageUsage.getRequests.mockResolvedValue([requests('2026-10-21', 'PutObject', 'api', 1)]);

    const { backends } = await sut.getUsage({});
    expect(backends[0]).toMatchObject({
      backendId: 'originals',
      cost: null,
      days: [expect.objectContaining({ cost: null })],
    });

    await expect(sut.getUsage({ from: '2026-10-22', to: '2026-10-21' })).rejects.toThrow('starts after it ends');
  });

  /** 10 GiB stored on each of the first `days` days of October, which costs 1 a day */
  const store = (days: number) =>
    mocks.storageUsage.getStored.mockImplementation((from: string, to: string) =>
      Promise.resolve(
        Array.from({ length: days }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`)
          .filter((day) => day >= from && day <= to)
          .map((day) => ({
            day,
            backendId: 'originals',
            category: StorageUsageCategory.Files,
            objects: 1,
            bytes: 10 * GIB,
          })),
      ),
    );

  describe('budgets', () => {
    const pricing = {
      backendId: 'originals',
      currency: 'CNY',
      storageGbMonth: 3,
      writeRequests10k: 0,
      readRequests10k: 0,
      deleteRequests10k: 0,
      egressGb: 0,
    };
    let reminders: Record<string, string[]> | null;
    let budget: number | null;

    beforeEach(() => {
      vi.useFakeTimers({ now: new Date('2026-10-10T12:00:00.000Z'), toFake: ['Date'] });
      reminders = null;
      budget = 20;
      mocks.systemMetadata.get.mockImplementation((key: SystemMetadataKey) =>
        Promise.resolve(
          key === SystemMetadataKey.SystemConfig
            ? { storagePricing: { backends: [{ ...pricing, monthlyBudget: budget }] } }
            : key === SystemMetadataKey.StorageBudgetReminders
              ? reminders
              : null,
        ),
      );
      mocks.systemMetadata.set.mockImplementation((_key: SystemMetadataKey, value: unknown) => {
        reminders = value as Record<string, string[]>;
        return Promise.resolve();
      });
      mocks.storageUsage.getRequests.mockResolvedValue([]);
      mocks.user.getAdmin.mockResolvedValue({ id: 'admin-id' } as never);
      mocks.notification.create.mockResolvedValue({ id: 'notification-id', createdAt: new Date() } as never);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should tell what the month cost so far, and will cost at that pace', async () => {
      store(10);

      const { backends } = await sut.getUsage({ from: '2026-10-09', to: '2026-10-10' });

      // 10 days at 1 a day so far; the 31 days of October at that pace
      expect(backends[0].budget).toEqual({
        month: '2026-10',
        currency: 'CNY',
        amount: 20,
        monthToDate: 10,
        projected: 31,
      });
      // the range asked for is still the range shown
      expect(backends[0].days.map(({ day }) => day)).toEqual(['2026-10-09', '2026-10-10']);
    });

    it('should have no budget without one in the settings', async () => {
      budget = null;
      store(10);

      const { backends } = await sut.getUsage({});

      expect(backends[0].budget).toBeNull();
    });

    it('should remind once a month when the budget would be exceeded, and once more when it is', async () => {
      store(10);
      await sut.handleSnapshot();
      await sut.handleSnapshot();

      expect(mocks.notification.create).toHaveBeenCalledOnce();
      expect(mocks.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'admin-id',
          level: NotificationLevel.Warning,
          title: 'Storage backend originals is on course to exceed its budget',
          description: expect.stringContaining('31.00 CNY, over the budget of 20.00 CNY'),
        }),
      );

      vi.setSystemTime(new Date('2026-10-25T12:00:00.000Z'));
      store(25);
      await sut.handleSnapshot();
      await sut.handleSnapshot();

      expect(mocks.notification.create).toHaveBeenCalledTimes(2);
      expect(mocks.notification.create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          level: NotificationLevel.Error,
          title: 'Storage backend originals exceeded its budget',
        }),
      );
      expect(reminders).toEqual({ originals: ['2026-10:projected', '2026-10:exceeded'] });
    });

    it('should not remind within the budget', async () => {
      store(5);
      vi.setSystemTime(new Date('2026-10-30T12:00:00.000Z'));

      await sut.handleSnapshot();

      expect(mocks.notification.create).not.toHaveBeenCalled();
    });
  });
});
