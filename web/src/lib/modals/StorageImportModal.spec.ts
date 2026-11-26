import { importDeletedOriginal } from '@immich/sdk';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
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
    vi.resetAllMocks();
  });

  test('imports the original for the chosen user, and closes', async () => {
    vi.mocked(importDeletedOriginal).mockResolvedValue(undefined as never);
    const onClose = vi.fn();
    await render(StorageImportModal, { props: { id: 'id-1', fileName: 'IMG_0001.jpg', users, onClose } });

    await page.getByRole('button', { name: 'admin.storage_import_original' }).click();

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    expect(importDeletedOriginal).toHaveBeenCalledWith({ id: 'id-1', storageDeletionImportDto: { userId: 'user-1' } });
  });

  test('stays open when the import fails', async () => {
    vi.mocked(importDeletedOriginal).mockRejectedValue(new Error('failed'));
    const onClose = vi.fn();
    await render(StorageImportModal, { props: { id: 'id-1', fileName: 'IMG_0001.jpg', users, onClose } });

    await page.getByRole('button', { name: 'admin.storage_import_original' }).click();

    await vi.waitFor(() => expect(importDeletedOriginal).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
  });
});
