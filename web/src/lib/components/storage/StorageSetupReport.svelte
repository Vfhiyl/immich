<script lang="ts">
  import { StorageSetupProblemKind, type StorageSetupResponseDto } from '@immich/sdk';
  import { Alert, HStack, Icon, Stack, Text } from '@immich/ui';
  import { mdiAlert, mdiCheck, mdiClose } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    report: StorageSetupResponseDto;
  };

  const { report }: Props = $props();

  type Problem = StorageSetupResponseDto['problems'][number];

  // what is wrong, and what to do about it
  const titleOf = ({ kind, path, backendId, keyId }: Problem) => {
    const values = { path: path ?? '', backendId: backendId ?? '', keyId: keyId ?? '' };
    switch (kind) {
      case StorageSetupProblemKind.ConfigurationMissing: {
        return $t('storage_setup_problem_configuration_missing', { values });
      }
      case StorageSetupProblemKind.ConfigurationInvalid: {
        return $t('storage_setup_problem_configuration_invalid', { values });
      }
      case StorageSetupProblemKind.MasterKeyFileMissing: {
        return $t('storage_setup_problem_master_key_file_missing', { values });
      }
      case StorageSetupProblemKind.MasterKeysInvalid: {
        return $t('storage_setup_problem_master_keys_invalid', { values });
      }
      case StorageSetupProblemKind.MasterKeyNotFound: {
        return $t('storage_setup_problem_master_key_not_found', { values });
      }
      case StorageSetupProblemKind.BackendFailed: {
        return $t('storage_setup_problem_backend_failed', { values });
      }
    }
  };

  const hintOf = ({ kind, keyId }: Problem) => {
    switch (kind) {
      case StorageSetupProblemKind.ConfigurationMissing: {
        return $t('storage_setup_hint_configuration_missing');
      }
      case StorageSetupProblemKind.ConfigurationInvalid: {
        return $t('storage_setup_hint_configuration_invalid');
      }
      case StorageSetupProblemKind.MasterKeyFileMissing: {
        return $t('storage_setup_hint_master_key_file_missing');
      }
      case StorageSetupProblemKind.MasterKeysInvalid: {
        return $t('storage_setup_hint_master_keys_invalid');
      }
      case StorageSetupProblemKind.MasterKeyNotFound: {
        return $t('storage_setup_hint_master_key_not_found', { values: { keyId: keyId ?? '' } });
      }
      case StorageSetupProblemKind.BackendFailed: {
        return $t('storage_setup_hint_backend_failed');
      }
    }
  };

  const failedBackends = $derived(new Set(report.problems.map(({ backendId }) => backendId).filter(Boolean)));
</script>

<Stack gap={3} class="w-full text-start">
  {#if report.configFile}
    <Text size="small">{$t('storage_setup_config_file', { values: { path: report.configFile } })}</Text>
  {:else}
    <Alert color="info" title={$t('storage_setup_none')} />
  {/if}

  {#each report.problems as problem, index (index)}
    <Alert color="danger" title={titleOf(problem)}>
      <Stack gap={1}>
        <Text size="small">{hintOf(problem)}</Text>
        <pre class="text-xs break-all whitespace-pre-wrap">{problem.message}</pre>
      </Stack>
    </Alert>
  {/each}

  {#if report.masterKeyId}
    <Text size="small">
      {$t('storage_setup_master_key', {
        values: { id: report.masterKeyId, source: report.masterKeyFile ?? report.masterKeyCommand ?? '' },
      })}
    </Text>
  {/if}

  {#each report.backends as backend (backend.id)}
    {@const values = { id: backend.id, role: backend.role, driver: backend.driver }}
    <HStack gap={2}>
      {#if backend.ok}
        <Icon icon={mdiCheck} class="text-success" />
        <Text size="small">{$t('storage_setup_backend_ok', { values })}</Text>
      {:else if failedBackends.has(backend.id)}
        <Icon icon={mdiClose} class="text-danger" />
        <Text size="small">{$t('storage_setup_backend_failed', { values })}</Text>
      {:else}
        <Icon icon={mdiAlert} class="text-warning" />
        <Text size="small">{$t('storage_setup_backend_unchecked', { values })}</Text>
      {/if}
    </HStack>
  {/each}

  {#if report.configFile && report.problems.length === 0}
    <Alert color="success" title={$t('storage_setup_works')} />
  {/if}

  {#if report.databaseBackups.length > 0}
    <Alert
      color="warning"
      title={$t('storage_setup_existing_backups', {
        values: { count: report.databaseBackups.length, filename: report.databaseBackups[0].filename },
      })}
    />
  {:else if report.hasOriginals}
    <Alert color="warning" title={$t('storage_setup_existing_originals')} />
  {/if}
</Stack>
