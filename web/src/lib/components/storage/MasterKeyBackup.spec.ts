import { StorageMasterKeySource } from '@immich/sdk';
import { render, screen } from '@testing-library/svelte';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getAnimateMock } from '$lib/__mocks__/animate.mock';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import { getVisualViewportMock } from '$lib/__mocks__/visual-viewport.mock';
import MasterKeyBackup from './MasterKeyBackup.svelte';

describe('MasterKeyBackup component', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
    vi.stubGlobal('visualViewport', getVisualViewportMock());
    Element.prototype.animate = getAnimateMock();
  });

  test('warns while the current master key was not downloaded', () => {
    render(MasterKeyBackup, { keyId: 'abc123', source: StorageMasterKeySource.File, savedAt: null });

    // the texts are keys in unit tests
    expect(screen.getByText('admin.storage_master_key_not_saved')).toBeInTheDocument();
    expect(screen.queryByText('admin.storage_master_key_saved')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'admin.storage_master_key_download' })).toBeInTheDocument();
    expect(screen.queryByText('admin.storage_master_key_from_command')).not.toBeInTheDocument();
  });

  test('tells when it was downloaded, and to keep a copy of keys from a key management service too', () => {
    render(MasterKeyBackup, {
      keyId: 'abc123',
      source: StorageMasterKeySource.Command,
      savedAt: new Date().toISOString(),
    });

    expect(screen.getByText('admin.storage_master_key_saved')).toBeInTheDocument();
    expect(screen.queryByText('admin.storage_master_key_not_saved')).not.toBeInTheDocument();
    expect(screen.getByText('admin.storage_master_key_from_command')).toBeInTheDocument();
  });
});
