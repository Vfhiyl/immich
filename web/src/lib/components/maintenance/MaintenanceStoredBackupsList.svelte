<script lang="ts">
  import { handleRestoreDatabaseBackup } from '$lib/services/database-backups.service';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { handleError } from '$lib/utils/handle-error';
  import {
    fetchMaintenanceStoredDatabaseBackup,
    getMaintenanceStoredDatabaseBackups,
    type StoredDatabaseBackupListResponseDto,
  } from '@immich/sdk';
  import { Button, Card, CardBody, HStack, Stack, Text } from '@immich/ui';
  import { mdiCloudDownloadOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let backups = $state<StoredDatabaseBackupListResponseDto['backups']>([]);
  let fetching = $state<string>();

  onMount(async () => {
    try {
      ({ backups } = await getMaintenanceStoredDatabaseBackups());
    } catch {
      // without a storage backend for backups, there are none
    }
  });

  const onRestore = async (key: string) => {
    fetching = key;
    try {
      // decrypted into the backups folder first, then restored like any backup
      const { filename } = await fetchMaintenanceStoredDatabaseBackup({ key });
      await handleRestoreDatabaseBackup(filename);
    } catch (error) {
      handleError(error, $t('maintenance_restore_storage_backup_error'));
    } finally {
      fetching = undefined;
    }
  };
</script>

{#if backups.length > 0}
  <Stack gap={2} class="mb-4 text-start">
    <Text fontWeight="semi-bold">{$t('maintenance_restore_storage_backups')}</Text>
    <Text size="small" color="muted">{$t('maintenance_restore_storage_backups_description')}</Text>
    {#each backups as backup (backup.key)}
      <Card>
        <CardBody>
          <HStack class="justify-between">
            <Stack gap={0}>
              <Text size="small" class="break-all">{backup.filename}</Text>
              <Text size="tiny" color="muted">{getByteUnitString(backup.size)}</Text>
            </Stack>
            <Button
              size="small"
              leadingIcon={mdiCloudDownloadOutline}
              loading={fetching === backup.key}
              disabled={!!fetching}
              onclick={() => onRestore(backup.key)}
            >
              {$t('restore')}
            </Button>
          </HStack>
        </CardBody>
      </Card>
    {/each}
  </Stack>
{/if}
