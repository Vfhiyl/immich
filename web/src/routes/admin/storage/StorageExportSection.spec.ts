import {
  StorageExportStatus,
  cancelStorageExport,
  getStorageExport,
  startStorageExport,
  type UserAdminResponseDto,
} from '@immich/sdk';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import StorageExportSection from './StorageExportSection.svelte';

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  getStorageExport: vi.fn(),
  startStorageExport: vi.fn(),
  cancelStorageExport: vi.fn(),
}));

const users = [{ id: 'user-1', email: 'ann@example.com' }] as UserAdminResponseDto[];
const running = {
  status: StorageExportStatus.Running,
  userIds: null,
  startedAt: '2026-10-23T00:00:00.000Z',
  finishedAt: null,
  total: 10,
  exported: 3,
  skipped: 1,
  failed: 0,
  lastError: null,
};

describe('StorageExportSection component', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  test('tells how to set the export location when there is none', async () => {
    await render(StorageExportSection, {
      props: { storageExport: { location: null, usesStorageTemplate: false, state: null }, users },
    });

    await expect.element(page.getByText('admin.storage_export_no_location')).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'admin.storage_export_start' })).not.toBeInTheDocument();
  });

  test('starts an export of every user, and shows its progress', async () => {
    vi.mocked(startStorageExport).mockResolvedValue(undefined as never);
    vi.mocked(getStorageExport).mockResolvedValue({ location: '/export', usesStorageTemplate: true, state: running });
    await render(StorageExportSection, {
      props: { storageExport: { location: '/export', usesStorageTemplate: true, state: null }, users },
    });

    await page.getByRole('button', { name: 'admin.storage_export_start' }).click();

    await vi.waitFor(() =>
      expect(startStorageExport).toHaveBeenCalledWith({ storageExportStartDto: { userIds: undefined } }),
    );
    await expect.element(page.getByText('admin.storage_export_status_running')).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'admin.storage_export_cancel' })).toBeInTheDocument();
  });

  test('stops a running export', async () => {
    vi.mocked(cancelStorageExport).mockResolvedValue(undefined as never);
    vi.mocked(getStorageExport).mockResolvedValue({
      location: '/export',
      usesStorageTemplate: false,
      state: { ...running, status: StorageExportStatus.Cancelled, finishedAt: '2026-10-23T01:00:00.000Z' },
    });
    await render(StorageExportSection, {
      props: { storageExport: { location: '/export', usesStorageTemplate: false, state: running }, users },
    });

    await page.getByRole('button', { name: 'admin.storage_export_cancel' }).click();

    await vi.waitFor(() => expect(cancelStorageExport).toHaveBeenCalled());
    await expect.element(page.getByRole('button', { name: 'admin.storage_export_start' })).toBeInTheDocument();
  });
});
