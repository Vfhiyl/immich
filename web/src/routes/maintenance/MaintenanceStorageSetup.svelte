<script lang="ts">
  import StorageSetupReport from '$lib/components/storage/StorageSetupReport.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import {
    continueAfterStorageSetup,
    getMaintenanceStorageSetup,
    getServerConfig,
    type StorageSetupResponseDto,
  } from '@immich/sdk';
  import { Button, Heading, HStack, LoadingSpinner, Text } from '@immich/ui';
  import { mdiArrowRight, mdiRefresh } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let report = $state<StorageSetupResponseDto>();
  let isChecking = $state(false);
  let isStarting = $state(false);

  /** Until the server started normally, e.g. to welcome a new server: no websocket tells a visitor who is not logged in */
  const waitForStart = async () => {
    isStarting = true;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      try {
        const { maintenanceMode } = await getServerConfig();
        if (!maintenanceMode) {
          location.assign('/');
          return;
        }
      } catch {
        // restarting
      }
    }
  };

  const check = async (action: () => Promise<StorageSetupResponseDto>) => {
    isChecking = true;
    try {
      report = await action();
    } catch (error) {
      handleError(error, $t('storage_setup_check_failed'));
    } finally {
      isChecking = false;
    }
  };

  const onContinue = () =>
    check(async () => {
      const result = await continueAfterStorageSetup();
      if (result.problems.length === 0) {
        // the server starts normally now
        void waitForStart();
      }
      return result;
    });

  onMount(() => check(() => getMaintenanceStorageSetup()));
</script>

<Heading size="large" color="primary" tag="h1">{$t('storage_setup_maintenance_title')}</Heading>
<Text>{$t('storage_setup_maintenance_description')}</Text>
<div class="w-full rounded-xl border border-light-300 bg-white p-6 dark:bg-black">
  {#if isStarting}
    <Text>{$t('server_restarting_description')}</Text>
  {:else if report}
    <StorageSetupReport {report} />
  {:else}
    <LoadingSpinner />
  {/if}
</div>
<HStack>
  <Button
    variant="ghost"
    leadingIcon={mdiRefresh}
    loading={isChecking}
    onclick={() => check(() => getMaintenanceStorageSetup())}
  >
    {$t('storage_setup_check_again')}
  </Button>
  <Button
    trailingIcon={mdiArrowRight}
    disabled={!report || report.problems.length > 0 || isChecking || isStarting}
    onclick={onContinue}
  >
    {$t('continue')}
  </Button>
</HStack>
