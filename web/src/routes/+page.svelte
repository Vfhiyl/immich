<script lang="ts">
  import AuthPageLayout from '$lib/components/layouts/AuthPageLayout.svelte';
  import ResourceCheckReport from '$lib/components/admin/ResourceCheckReport.svelte';
  import StorageSetupReport from '$lib/components/storage/StorageSetupReport.svelte';
  import { Route } from '$lib/route';
  import { websocketStore } from '$lib/stores/websocket';
  import { handleError } from '$lib/utils/handle-error';
  import {
    getResourceSetupCheck,
    getStorageSetup,
    startDatabaseRestoreFlow,
    type ResourceCheckResponseDto,
    type StorageSetupResponseDto,
  } from '@immich/sdk';
  import { Button, Heading, Stack } from '@immich/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  // what the new server finds in its storage: e.g. the photos and database backups of a server it replaces
  let storage = $state<StorageSetupResponseDto>();
  const isRestore = $derived(!!storage && (storage.hasOriginals || storage.databaseBackups.length > 0));

  // what the new server has to run on: memory, cores, disk, and whether machine learning answers
  let resources = $state<ResourceCheckResponseDto>();

  onMount(async () => {
    try {
      storage = await getStorageSetup();
    } catch {
      // not shown when it cannot be read
    }
  });

  onMount(async () => {
    try {
      resources = await getResourceSetupCheck();
    } catch {
      // not shown when it cannot be read
    }
  });

  async function switchToMaintenance() {
    try {
      websocketStore.serverRestarting.set({
        isMaintenanceMode: true,
      });

      await startDatabaseRestoreFlow();
    } catch (error) {
      handleError(error, $t('admin.maintenance_start_error'));
    }
  }
</script>

<AuthPageLayout>
  <div class="flex flex-col place-items-center gap-12 text-center">
    <Heading size="large" color="primary" tag="h1">{$t('welcome_to_immich')}</Heading>
    <Stack>
      <Button
        href={Route.register()}
        size={isRestore ? 'small' : 'large'}
        shape="round"
        variant={isRestore ? 'ghost' : 'filled'}
      >
        <span class="px-2 font-semibold">{$t('getting_started')}</span>
      </Button>
      <Button
        size={isRestore ? 'large' : 'small'}
        shape="round"
        variant={isRestore ? 'filled' : 'ghost'}
        onclick={switchToMaintenance}
      >
        <span class="px-2 font-semibold">{$t('maintenance_restore_from_backup')}</span>
      </Button>
    </Stack>
    {#if storage}
      <div class="w-full max-w-xl rounded-xl border border-light-300 bg-white p-4 dark:bg-black">
        <StorageSetupReport report={storage} />
      </div>
    {/if}
    {#if resources}
      <div class="w-full max-w-xl rounded-xl border border-light-300 bg-white p-4 dark:bg-black">
        <ResourceCheckReport check={resources} />
      </div>
    {/if}
  </div>
</AuthPageLayout>
