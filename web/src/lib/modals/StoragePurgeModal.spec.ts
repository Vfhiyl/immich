import { purgeDeletedOriginal } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { getAnimateMock } from '$lib/__mocks__/animate.mock';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import { getVisualViewportMock } from '$lib/__mocks__/visual-viewport.mock';
import StoragePurgeModal from './StoragePurgeModal.svelte';

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  purgeDeletedOriginal: vi.fn(),
}));

describe('StoragePurgeModal component', () => {
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

  test('deletes the original only once the password is entered, and closes', async () => {
    vi.mocked(purgeDeletedOriginal).mockResolvedValue(undefined as never);
    const onClose = vi.fn();
    render(StoragePurgeModal, { props: { id: 'id-1', fileName: 'IMG_0001.jpg', onClose } });

    const submit = await screen.findByRole('button', { name: 'admin.storage_purge_original' });
    expect(submit).toBeDisabled();

    const password = document.querySelector('input[type="password"]') as HTMLInputElement;
    await fireEvent.input(password, { target: { value: 'secret' } });
    expect(submit).not.toBeDisabled();
    await fireEvent.click(submit);

    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    expect(purgeDeletedOriginal).toHaveBeenCalledWith({ id: 'id-1', storageDeletionPurgeDto: { password: 'secret' } });
  });
});
