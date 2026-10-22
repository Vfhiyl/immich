<script lang="ts">
  import AdminPageLayout from '$lib/components/layouts/AdminPageLayout.svelte';
  import { Route } from '$lib/route';
  import {
    formatAge,
    handleFetchStoredDatabaseBackup,
    handleResumeStorageDeletion,
    handleRetryReplicaCopies,
    handleStartStorageCheck,
    toPercent,
  } from '$lib/services/storage.service';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { getStorageDeletionStatus, getStorageReplicas, StorageCheckKind, type StorageCheckRunDto } from '@immich/sdk';
  import {
    Alert,
    Button,
    Container,
    HStack,
    Stack,
    Table,
    TableBody,
    TableCell,
    TableHeader,
    TableHeading,
    TableRow,
    Text,
  } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  type Props = {
    data: PageData;
  };

  const { data }: Props = $props();

  let deletion = $state(data.deletion);
  let replicas = $state(data.replicas);

  const openIssues = $derived(Object.values(data.health?.openIssues ?? {}).reduce((total, count) => total + count, 0));

  const formatRun = (run: StorageCheckRunDto | null | undefined) =>
    run
      ? $t('admin.storage_check_run', {
          values: { status: run.status, age: formatAge(run.startedAt), checked: run.checked },
        })
      : $t('admin.storage_check_never');

  const onResume = async () => {
    if (await handleResumeStorageDeletion()) {
      deletion = await getStorageDeletionStatus();
    }
  };

  const onRetry = async (id: string) => {
    if (await handleRetryReplicaCopies(id)) {
      replicas = await getStorageReplicas();
    }
  };
</script>

<AdminPageLayout breadcrumbs={[{ title: data.meta.title }]}>
  <Container size="large" center class="my-4 flex flex-col gap-8 pb-28">
    <section>
      <Text size="large" fontWeight="semi-bold">{$t('admin.storage_configuration')}</Text>
      <Text size="small" color="muted" class="mb-3">{$t('admin.storage_configuration_description')}</Text>
      {#if data.configuration.backends.length === 0}
        <Alert color="info" title={$t('admin.storage_no_backends')} />
      {:else}
        <Table striped spacing="tiny">
          <TableHeader>
            <TableHeading>{$t('admin.storage_backend')}</TableHeading>
            <TableHeading>{$t('admin.storage_role')}</TableHeading>
            <TableHeading>{$t('admin.storage_location')}</TableHeading>
            <TableHeading>{$t('admin.storage_encrypted')}</TableHeading>
          </TableHeader>
          <TableBody>
            {#each data.configuration.backends as backend (backend.id)}
              <TableRow>
                <TableCell>{backend.id}</TableCell>
                <TableCell>
                  {backend.role}{backend.replicaOf ? ` (${backend.replicaOf.join(', ')})` : ''}
                </TableCell>
                <TableCell class="break-all">{backend.driver}: {backend.location}</TableCell>
                <TableCell>{backend.encrypted ? $t('yes') : $t('no')}</TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
        <Text size="small" color="muted" class="mt-2">
          {$t('admin.storage_settings_summary', {
            values: {
              delayDays: data.configuration.deletionDelayDays,
              keepLast: data.configuration.databaseBackupsKeepLast,
              retention: data.configuration.syncDeleteRetentionDays ?? $t('admin.storage_forever'),
            },
          })}
          {#if data.configuration.masterKeyId}
            {$t('admin.storage_master_key', { values: { id: data.configuration.masterKeyId } })}
          {/if}
        </Text>
      {/if}
    </section>

    {#if data.health}
      <section>
        <HStack class="justify-between">
          <Text size="large" fontWeight="semi-bold">{$t('admin.storage_data_health')}</Text>
          <HStack gap={1}>
            <Button size="small" variant="ghost" onclick={() => handleStartStorageCheck(StorageCheckKind.Reconcile)}>
              {$t('admin.storage_check_reconcile')}
            </Button>
            <Button size="small" variant="ghost" onclick={() => handleStartStorageCheck(StorageCheckKind.Verify)}>
              {$t('admin.storage_check_verify')}
            </Button>
            <Button size="small" href={Route.storageIssues()}>{$t('admin.storage_view_reports')}</Button>
          </HStack>
        </HStack>
        <Stack gap={1} class="mt-3">
          {#if openIssues > 0}
            <Alert color="danger" title={$t('admin.storage_open_issues', { values: { count: openIssues } })} />
          {:else}
            <Alert color="success" title={$t('admin.storage_no_issues')} />
          {/if}
          <Text size="small">{$t('admin.storage_last_reconcile')}: {formatRun(data.health.lastReconcile)}</Text>
          <Text size="small">{$t('admin.storage_last_verify')}: {formatRun(data.health.lastVerify)}</Text>
        </Stack>
      </section>
    {/if}

    {#if deletion}
      <section>
        <HStack class="justify-between">
          <Text size="large" fontWeight="semi-bold">{$t('admin.storage_deletions')}</Text>
          <Button size="small" href={Route.storageDeletedOriginals()}
            >{$t('admin.storage_view_deleted_originals')}</Button
          >
        </HStack>
        <Stack gap={2} class="mt-3">
          {#if deletion.isPaused}
            <Alert
              color="danger"
              title={$t('admin.storage_deletion_paused', {
                values: { due: deletion.dueOriginals ?? 0, limit: deletion.limit ?? 0 },
              })}
            >
              <Button size="small" color="danger" class="mt-2" onclick={onResume}>
                {$t('admin.storage_deletion_resume')}
              </Button>
            </Alert>
          {/if}
          <Text size="small">
            {$t('admin.storage_deletion_pending', {
              values: { originals: deletion.pendingOriginals, files: deletion.pendingFiles, days: deletion.delayDays },
            })}
          </Text>
        </Stack>
      </section>
    {/if}

    {#if replicas && replicas.replicas.length > 0}
      <section>
        <Text size="large" fontWeight="semi-bold">{$t('admin.storage_replicas')}</Text>
        <Text size="small" color="muted" class="mb-3">
          {$t('admin.storage_last_replica_reconcile')}: {formatAge(replicas.lastReconcileAt) ??
            $t('admin.storage_check_never')}
        </Text>
        <Table striped spacing="tiny">
          <TableHeader>
            <TableHeading>{$t('admin.storage_backend')}</TableHeading>
            <TableHeading>{$t('admin.storage_replica_copied')}</TableHeading>
            <TableHeading>{$t('admin.storage_replica_pending')}</TableHeading>
            <TableHeading>{$t('admin.storage_replica_oldest_pending')}</TableHeading>
            <TableHeading>{$t('admin.storage_replica_failing')}</TableHeading>
          </TableHeader>
          <TableBody>
            {#each replicas.replicas as replica (replica.id)}
              <TableRow>
                <TableCell>{replica.id} ({replica.replicaOf.join(', ')})</TableCell>
                <TableCell>
                  {toPercent(replica.copied, replica.sourceFiles)}% · {replica.copied} / {replica.sourceFiles} · {getByteUnitString(
                    replica.copiedBytes,
                  )}
                </TableCell>
                <TableCell>{replica.pending}</TableCell>
                <TableCell>{formatAge(replica.oldestPendingAt) ?? '–'}</TableCell>
                <TableCell>
                  {replica.failing}
                  {#if replica.failing > 0}
                    <Button size="tiny" variant="ghost" onclick={() => onRetry(replica.id)}>{$t('retry')}</Button>
                  {/if}
                </TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      </section>
    {/if}

    {#if data.databaseBackups}
      <section>
        <Text size="large" fontWeight="semi-bold">{$t('admin.storage_database_backups')}</Text>
        <Text size="small" color="muted" class="mb-3">{$t('admin.storage_database_backups_description')}</Text>
        <Table striped spacing="tiny">
          <TableBody>
            {#each data.databaseBackups.backups as backup (backup.key)}
              <TableRow>
                <TableCell>{backup.filename}</TableCell>
                <TableCell>{getByteUnitString(backup.size)}</TableCell>
                <TableCell>
                  <Button size="tiny" variant="ghost" onclick={() => handleFetchStoredDatabaseBackup(backup.key)}>
                    {$t('admin.storage_database_backup_fetch')}
                  </Button>
                </TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      </section>
    {/if}
  </Container>
</AdminPageLayout>
