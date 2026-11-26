import { purgeDeletedOriginal } from '@immich/sdk';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import StoragePurgeModal from './StoragePurgeModal.svelte';

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  purgeDeletedOriginal: vi.fn(),
}));

describe('StoragePurgeModal component', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  test('deletes the original only once the password is entered, and closes', async () => {
    vi.mocked(purgeDeletedOriginal).mockResolvedValue(undefined as never);
    const onClose = vi.fn();
    await render(StoragePurgeModal, { props: { id: 'id-1', fileName: 'IMG_0001.jpg', onClose } });

    const submit = page.getByRole('button', { name: 'admin.storage_purge_original' });
    await expect.element(submit).toBeDisabled();

    const password = page.elementLocator(document.querySelector('input[type="password"]')!);
    await password.fill('secret');
    await expect.element(submit).not.toBeDisabled();
    await submit.click();

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    expect(purgeDeletedOriginal).toHaveBeenCalledWith({ id: 'id-1', storageDeletionPurgeDto: { password: 'secret' } });
  });
});
