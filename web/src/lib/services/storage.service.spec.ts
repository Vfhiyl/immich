import { purgeDeletedOriginal, retryStorageReplicaCopies } from '@immich/sdk';
import { DateTime, Settings } from 'luxon';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatAge,
  handlePurgeDeletedOriginal,
  handleRetryReplicaCopies,
  toPercent,
} from '$lib/services/storage.service';

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  purgeDeletedOriginal: vi.fn(),
  retryStorageReplicaCopies: vi.fn(),
}));

vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));

describe('storage service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // the app sets the locale of the user
    Settings.defaultLocale = 'en';
  });

  it('should tell how long ago something was', () => {
    const now = DateTime.fromISO('2026-10-22T12:00:00Z');
    expect(formatAge('2026-10-22T09:00:00Z', now)).toBe('3 hours ago');
    expect(formatAge(null, now)).toBeNull();
  });

  it('should tell how far copying is, all done when there is nothing to copy', () => {
    expect(toPercent(1, 3)).toBe(33);
    expect(toPercent(5, 4)).toBe(100);
    expect(toPercent(0, 0)).toBe(100);
  });

  it('should delete a deleted original with the password of the administrator', async () => {
    vi.mocked(purgeDeletedOriginal).mockResolvedValue(undefined as never);

    await expect(handlePurgeDeletedOriginal('id-1', 'secret')).resolves.toBe(true);

    expect(purgeDeletedOriginal).toHaveBeenCalledWith({ id: 'id-1', storageDeletionPurgeDto: { password: 'secret' } });
  });

  it('should report a deletion that failed, e.g. for a wrong password', async () => {
    vi.mocked(purgeDeletedOriginal).mockRejectedValue(new Error('Wrong password'));

    await expect(handlePurgeDeletedOriginal('id-1', 'wrong')).resolves.toBe(false);
  });

  it('should retry the failed copies of a replica', async () => {
    vi.mocked(retryStorageReplicaCopies).mockResolvedValue({ count: 2 });

    await expect(handleRetryReplicaCopies('replica-1')).resolves.toBe(true);

    expect(retryStorageReplicaCopies).toHaveBeenCalledWith({ id: 'replica-1' });
  });
});
