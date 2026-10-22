import { setTimeout as sleep } from 'node:timers/promises';
import { StorageMeter, getStoragePurpose, withStoragePurpose } from 'src/utils/storage-metering.js';

describe(StorageMeter.name, () => {
  const request = { operation: 'GetObject', bytesSent: 0, bytesReceived: 100 };

  it('should count requests per day, backend, operation and what made them', async () => {
    const meter = new StorageMeter();
    const day = new Date('2026-10-22T10:00:00Z');

    meter.record('originals', request, day);
    meter.record('originals', request, day);
    await withStoragePurpose('AssetGenerateThumbnails', async () => {
      await sleep(1);
      meter.record('originals', request, day);
    });
    meter.record('originals', request, new Date('2026-10-23T00:00:00Z'));

    const usage = meter.drain();
    expect(usage).toHaveLength(3);
    expect(usage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          day: '2026-10-22',
          purpose: 'AssetGenerateThumbnails',
          requests: 1,
          bytesReceived: 100,
        }),
        expect.objectContaining({ day: '2026-10-22', purpose: 'api', requests: 2, bytesReceived: 200 }),
        expect.objectContaining({ day: '2026-10-23', purpose: 'api', requests: 1 }),
      ]),
    );
    expect(meter.drain()).toEqual([]);
  });

  it('should count requests outside of jobs for users', () => {
    expect(getStoragePurpose()).toBe('api');
    expect(withStoragePurpose('StorageReplicate', () => getStoragePurpose())).toBe('StorageReplicate');
  });
});
