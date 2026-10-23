<script lang="ts">
  import StorageSetupReport from '$lib/components/storage/StorageSetupReport.svelte';
  import {
    detectPriorInstall,
    getMaintenanceStorageSetup,
    type MaintenanceDetectInstallResponseDto,
    type StorageSetupResponseDto,
  } from '@immich/sdk';
  import { Button, Heading, HStack, Icon, Stack, Text } from '@immich/ui';
  import { mdiAlert, mdiArrowRight, mdiCheck, mdiClose, mdiRefresh } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    next: () => void;
    end: () => void;
  };

  const { next, end }: Props = $props();

  let detectedInstall: MaintenanceDetectInstallResponseDto | undefined = $state();
  let storage: StorageSetupResponseDto | undefined = $state();

  // with storage backends, photos are in storage rather than in these folders
  const usesBackends = $derived(!!storage?.configFile && storage.backends.length > 0);
  const isRequired = (folder: string) => !usesBackends && (folder === 'profile' || folder === 'upload');

  const reload = async () => {
    [detectedInstall, storage] = await Promise.all([
      detectPriorInstall(),
      getMaintenanceStorageSetup().catch(() => undefined),
    ]);
  };

  const getLibraryFolderCheckStatus = (writable: boolean, readable: boolean) => {
    if (writable) {
      return $t('maintenance_restore_library_folder_pass');
    }
    return readable
      ? $t('maintenance_restore_library_folder_write_fail')
      : $t('maintenance_restore_library_folder_read_fail');
  };

  onMount(() => reload());
</script>

<Heading size="large" color="primary" tag="h1">{$t('maintenance_restore_library')}</Heading>
<Text>{$t('maintenance_restore_library_description')}</Text>
{#if storage?.configFile}
  <div class="m-4 w-full rounded-xl border border-light-300 bg-white p-6 dark:bg-black">
    <StorageSetupReport report={storage} />
  </div>
{/if}
<div class="m-4 w-full rounded-xl border border-light-300 bg-white p-6 dark:bg-black">
  <Stack>
    {#if detectedInstall}
      {#each detectedInstall.storage as { folder, readable, writable } (folder)}
        <HStack>
          <Icon icon={writable ? mdiCheck : mdiClose} class={writable ? 'text-success' : 'text-danger'} />
          <Text>{folder} ({getLibraryFolderCheckStatus(writable, readable)})</Text>
        </HStack>
      {/each}
      {#each detectedInstall.storage as { folder, files } (folder)}
        {#if folder !== 'backups'}
          <HStack class="items-start">
            <Icon
              class={`mt-1 ${files ? 'text-success' : isRequired(folder) ? 'text-danger' : 'text-warning'}`}
              icon={files ? mdiCheck : isRequired(folder) ? mdiClose : mdiAlert}
            />
            <Stack gap={0} class="items-start">
              <Text>
                {#if files}
                  {$t('maintenance_restore_library_folder_has_files', {
                    values: {
                      folder,
                      count: files,
                    },
                  })}
                {:else}
                  {$t('maintenance_restore_library_folder_no_files', {
                    values: {
                      folder,
                    },
                  })}
                {/if}
              </Text>
              {#if !files}
                {#if usesBackends && (folder === 'profile' || folder === 'upload')}
                  <Text variant="italic">{$t('maintenance_restore_library_hint_on_storage_backends')}</Text>
                {:else if folder === 'profile' || folder === 'upload'}
                  <Text variant="italic">{$t('maintenance_restore_library_hint_missing_files')}</Text>
                {/if}
                {#if folder === 'encoded-video' || folder === 'thumbs'}
                  <Text variant="italic">{$t('maintenance_restore_library_hint_regenerate_later')}</Text>
                {/if}
                {#if folder === 'library'}
                  <Text variant="italic">{$t('maintenance_restore_library_hint_storage_template_missing_files')}</Text>
                {/if}
              {/if}
            </Stack>
          </HStack>
        {/if}
      {/each}

      <Button leadingIcon={mdiRefresh} variant="ghost" onclick={reload}>{$t('refresh')}</Button>
    {:else}
      <HStack>
        <Icon icon={mdiRefresh} color="rgb(var(--immich-ui-primary))" />
        <Text>{$t('maintenance_restore_library_loading')}</Text>
      </HStack>
    {/if}
  </Stack>
</div>
<Text>{$t('maintenance_restore_library_confirm')}</Text>
<HStack>
  <Button onclick={end} variant="ghost">{$t('cancel')}</Button>
  <Button onclick={next} trailingIcon={mdiArrowRight}>{$t('next')}</Button>
</HStack>
