<script lang="ts">
  import { Button, Heading, HStack, Scrollable } from '@immich/ui';
  import { mdiArrowLeft } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import MaintenanceBackupsList from '$lib/components/maintenance/MaintenanceBackupsList.svelte';
  import MaintenanceStoredBackupsList from '$lib/components/maintenance/MaintenanceStoredBackupsList.svelte';

  type Props = {
    previous: () => void;
    end: () => void;
    expectedVersion: string;
  };

  const { previous, end, expectedVersion }: Props = $props();
</script>

<Heading size="large" color="primary" tag="h1">{$t('maintenance_restore_from_backup')}</Heading>
<Scrollable class="max-h-120 w-full rounded-2xl border border-light-300 bg-white p-4 dark:bg-black">
  <!-- the backups on the storage backend for backups, of a server that is restored -->
  <MaintenanceStoredBackupsList />
  <MaintenanceBackupsList {expectedVersion} />
</Scrollable>
<HStack>
  <Button onclick={end} variant="ghost">{$t('cancel')}</Button>
  <Button onclick={previous} variant="ghost" leadingIcon={mdiArrowLeft}>{$t('back')}</Button>
</HStack>
