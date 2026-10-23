<script lang="ts">
  import MasterKeyBackup from '$lib/components/storage/MasterKeyBackup.svelte';
  import { getStorageConfiguration } from '@immich/sdk';
  import { t } from 'svelte-i18n';
</script>

<div class="flex flex-col gap-4">
  <p>{$t('admin.storage_master_key_onboarding_description')}</p>
  {#await getStorageConfiguration() then configuration}
    {#if configuration.masterKeyId}
      <MasterKeyBackup
        keyId={configuration.masterKeyId}
        source={configuration.masterKeySource}
        savedAt={configuration.masterKeySavedAt}
      />
    {/if}
  {/await}
</div>
