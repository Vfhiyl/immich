import {
  getStorageCheckSummary,
  getStorageConfiguration,
  getStorageDeletionStatus,
  getStorageReplicas,
  getStoredDatabaseBackups,
  StorageBackendRole,
} from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url, { admin: true });

  const configuration = await getStorageConfiguration();
  const hasBackends = configuration.backends.length > 0;
  const hasBackupBackend = configuration.backends.some(({ role }) => role === StorageBackendRole.Backup);
  const [health, deletion, replicas, databaseBackups] = await Promise.all([
    hasBackends ? getStorageCheckSummary() : undefined,
    hasBackends ? getStorageDeletionStatus() : undefined,
    hasBackends ? getStorageReplicas() : undefined,
    hasBackupBackend ? getStoredDatabaseBackups() : undefined,
  ]);

  const $t = await getFormatter();

  return {
    configuration,
    health,
    deletion,
    replicas,
    databaseBackups,
    meta: {
      title: $t('admin.storage'),
    },
  };
}) satisfies PageLoad;
