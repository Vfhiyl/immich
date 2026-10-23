<script lang="ts">
  import { handleCancelStorageExport, handleStartStorageExport } from '$lib/services/storage.service';
  import { getStorageExport, type StorageExportResponseDto, type UserAdminResponseDto } from '@immich/sdk';
  import { Alert, Button, Field, HStack, Select, Stack, Text } from '@immich/ui';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    storageExport: StorageExportResponseDto;
    users: UserAdminResponseDto[];
  };

  const { storageExport: initial, users }: Props = $props();

  let storageExport = $state(initial);
  let userId = $state('');
  const isRunning = $derived(storageExport.state?.status === 'running');
  const handled = $derived(
    storageExport.state ? storageExport.state.exported + storageExport.state.skipped + storageExport.state.failed : 0,
  );

  const refresh = async () => {
    storageExport = await getStorageExport();
  };

  // follows a running export
  const timer = setInterval(() => {
    if (isRunning) {
      void refresh();
    }
  }, 5000);
  onDestroy(() => clearInterval(timer));

  const onStart = async () => {
    if (await handleStartStorageExport(userId ? [userId] : undefined)) {
      await refresh();
    }
  };

  const onCancel = async () => {
    if (await handleCancelStorageExport()) {
      await refresh();
    }
  };
</script>

<section>
  <Text size="large" fontWeight="semi-bold">{$t('admin.storage_export')}</Text>
  <Text size="small" color="muted" class="mb-3">{$t('admin.storage_export_description')}</Text>
  {#if storageExport.location}
    <Stack gap={3}>
      <Text size="small">
        {$t('admin.storage_export_location', { values: { location: storageExport.location } })}
        · {storageExport.usesStorageTemplate
          ? $t('admin.storage_export_named_by_template')
          : $t('admin.storage_export_named_by_date')}
      </Text>
      {#if storageExport.state}
        {@const state = storageExport.state}
        <Alert
          color={state.status === 'running'
            ? 'info'
            : state.failed > 0 || state.status === 'failed'
              ? 'warning'
              : 'success'}
          title={$t(`admin.storage_export_status_${state.status}`, {
            values: {
              handled,
              total: state.total,
              exported: state.exported,
              skipped: state.skipped,
              failed: state.failed,
            },
          })}
        >
          {#if state.lastError}
            <Text size="small" class="break-all">{state.lastError}</Text>
          {/if}
        </Alert>
      {/if}
      <HStack gap={2} class="items-end">
        <Field label={$t('admin.storage_export_users')}>
          <Select
            bind:value={userId}
            options={[
              { label: $t('admin.storage_export_all_users'), value: '' },
              ...users.map((user) => ({ label: user.email, value: user.id })),
            ]}
          />
        </Field>
        {#if isRunning}
          <Button size="small" color="danger" variant="ghost" onclick={onCancel}
            >{$t('admin.storage_export_cancel')}</Button
          >
        {:else}
          <Button size="small" onclick={onStart}>{$t('admin.storage_export_start')}</Button>
        {/if}
      </HStack>
    </Stack>
  {:else}
    <Alert color="info" title={$t('admin.storage_export_no_location')} />
  {/if}
</section>
