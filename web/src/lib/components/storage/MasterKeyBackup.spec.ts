import { StorageMasterKeySource } from '@immich/sdk';
import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import MasterKeyBackup from './MasterKeyBackup.svelte';

describe('MasterKeyBackup component', () => {
  test('warns while the current master key was not downloaded', async () => {
    await render(MasterKeyBackup, { keyId: 'abc123', source: StorageMasterKeySource.File, savedAt: null });

    // the texts are keys in unit tests
    await expect.element(page.getByText('admin.storage_master_key_not_saved')).toBeInTheDocument();
    await expect.element(page.getByText('admin.storage_master_key_saved')).not.toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'admin.storage_master_key_download' })).toBeInTheDocument();
    await expect.element(page.getByText('admin.storage_master_key_from_command')).not.toBeInTheDocument();
  });

  test('tells when it was downloaded, and to keep a copy of keys from a key management service too', async () => {
    await render(MasterKeyBackup, {
      keyId: 'abc123',
      source: StorageMasterKeySource.Command,
      savedAt: new Date().toISOString(),
    });

    await expect.element(page.getByText('admin.storage_master_key_saved')).toBeInTheDocument();
    await expect.element(page.getByText('admin.storage_master_key_not_saved')).not.toBeInTheDocument();
    await expect.element(page.getByText('admin.storage_master_key_from_command')).toBeInTheDocument();
  });
});
