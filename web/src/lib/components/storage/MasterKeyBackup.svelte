<script lang="ts">
  import StorageMasterKeyModal from '$lib/modals/StorageMasterKeyModal.svelte';
  import { formatAge } from '$lib/services/storage.service';
  import { StorageMasterKeySource } from '@immich/sdk';
  import { Alert, Button, modalManager, Stack, Text } from '@immich/ui';
  import { mdiDownload } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    keyId: string;
    source: StorageMasterKeySource | null | undefined;
    savedAt: string | null | undefined;
  };

  const { keyId, source, savedAt: initialSavedAt }: Props = $props();

  let savedAt = $state(initialSavedAt);

  const onDownload = async () => {
    if (await modalManager.show(StorageMasterKeyModal, {})) {
      savedAt = new Date().toISOString();
    }
  };
</script>

<Stack gap={2}>
  {#if savedAt}
    <Alert
      color="success"
      title={$t('admin.storage_master_key_saved', { values: { id: keyId, age: formatAge(savedAt) } })}
    />
  {:else}
    <Alert color="danger" title={$t('admin.storage_master_key_not_saved', { values: { id: keyId } })} />
  {/if}
  <Text size="small">{$t('admin.storage_master_key_backup_description')}</Text>
  {#if source === StorageMasterKeySource.Command}
    <Text size="small" color="muted">{$t('admin.storage_master_key_from_command')}</Text>
  {/if}
  <div>
    <Button size="small" leadingIcon={mdiDownload} onclick={onDownload}>
      {$t('admin.storage_master_key_download')}
    </Button>
  </div>
</Stack>
