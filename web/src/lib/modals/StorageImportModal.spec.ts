import { importDeletedOriginal } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { getAnimateMock } from '$lib/__mocks__/animate.mock';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import { getVisualViewportMock } from '$lib/__mocks__/visual-viewport.mock';
import StorageImportModal from './StorageImportModal.svelte';

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  importDeletedOriginal: vi.fn(),
}));

describe('StorageImportModal component', () => {
  const users = [
    { id: 'user-1', email: 'first@example.com' },
    { id: 'user-2', email: 'second@example.com' },
  ];

  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
    vi.stubGlobal('visualViewport', getVisualViewportMock());
    vi.resetAllMocks();
    Element.prototype.animate = getAnimateMock();
  });

  afterAll(async () => {
    await waitFor(() => {
      expect(document.body.style.pointerEvents).not.toBe('none');
    });
  });

  test('imports the original for the chosen user, and closes', async () => {
    vi.mocked(importDeletedOriginal).mockResolvedValue(undefined as never);
    const onClose = vi.fn();
    render(StorageImportModal, { props: { id: 'id-1', fileName: 'IMG_0001.jpg', users, onClose } });

    await fireEvent.click(await screen.findByRole('button', { name: 'admin.storage_import_original' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    expect(importDeletedOriginal).toHaveBeenCalledWith({ id: 'id-1', storageDeletionImportDto: { userId: 'user-1' } });
  });

  test('stays open when the import fails', async () => {
    vi.mocked(importDeletedOriginal).mockRejectedValue(new Error('failed'));
    const onClose = vi.fn();
    render(StorageImportModal, { props: { id: 'id-1', fileName: 'IMG_0001.jpg', users, onClose } });

    await fireEvent.click(await screen.findByRole('button', { name: 'admin.storage_import_original' }));

    await waitFor(() => expect(importDeletedOriginal).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
  });
});
