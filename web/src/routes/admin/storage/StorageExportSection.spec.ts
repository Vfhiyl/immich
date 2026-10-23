import {
  cancelStorageExport,
  getStorageExport,
  startStorageExport,
  StorageExportStatus,
  type UserAdminResponseDto,
} from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getAnimateMock } from '$lib/__mocks__/animate.mock';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import { getVisualViewportMock } from '$lib/__mocks__/visual-viewport.mock';
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
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
    vi.stubGlobal('visualViewport', getVisualViewportMock());
    vi.resetAllMocks();
    Element.prototype.animate = getAnimateMock();
  });

  test('tells how to set the export location when there is none', () => {
    render(StorageExportSection, {
      props: { storageExport: { location: null, usesStorageTemplate: false, state: null }, users },
    });

    expect(screen.getByText('admin.storage_export_no_location')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'admin.storage_export_start' })).not.toBeInTheDocument();
  });

  test('starts an export of every user, and shows its progress', async () => {
    vi.mocked(startStorageExport).mockResolvedValue(undefined as never);
    vi.mocked(getStorageExport).mockResolvedValue({ location: '/export', usesStorageTemplate: true, state: running });
    render(StorageExportSection, {
      props: { storageExport: { location: '/export', usesStorageTemplate: true, state: null }, users },
    });

    await fireEvent.click(screen.getByRole('button', { name: 'admin.storage_export_start' }));

    await waitFor(() =>
      expect(startStorageExport).toHaveBeenCalledWith({ storageExportStartDto: { userIds: undefined } }),
    );
    expect(await screen.findByText('admin.storage_export_status_running')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'admin.storage_export_cancel' })).toBeInTheDocument();
  });

  test('stops a running export', async () => {
    vi.mocked(cancelStorageExport).mockResolvedValue(undefined as never);
    vi.mocked(getStorageExport).mockResolvedValue({
      location: '/export',
      usesStorageTemplate: false,
      state: { ...running, status: StorageExportStatus.Cancelled, finishedAt: '2026-10-23T01:00:00.000Z' },
    });
    render(StorageExportSection, {
      props: { storageExport: { location: '/export', usesStorageTemplate: false, state: running }, users },
    });

    await fireEvent.click(screen.getByRole('button', { name: 'admin.storage_export_cancel' }));

    await waitFor(() => expect(cancelStorageExport).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: 'admin.storage_export_start' })).toBeInTheDocument();
  });
});
