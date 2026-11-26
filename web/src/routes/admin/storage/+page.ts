import { authenticate } from '#lib/utils/auth.ts';
import { getFormatter } from '#lib/utils/i18n.ts';
import {
  StorageBackendRole,
  getStorageCheckSummary,
  getStorageConfiguration,
  getStorageDeletionStatus,
  getStorageExport,
  getStorageReplicas,
  getStoredDatabaseBackups,
  searchUsersAdmin,
} from '@immich/sdk';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url, { admin: true });

  const configuration = await getStorageConfiguration();
  const hasBackends = configuration.backends.length > 0;
  const hasBackupBackend = configuration.backends.some(({ role }) => role === StorageBackendRole.Backup);
  const [health, deletion, replicas, databaseBackups, storageExport, users] = await Promise.all([
    hasBackends ? getStorageCheckSummary() : undefined,
    hasBackends ? getStorageDeletionStatus() : undefined,
    hasBackends ? getStorageReplicas() : undefined,
    hasBackupBackend ? getStoredDatabaseBackups() : undefined,
    getStorageExport(),
    searchUsersAdmin({ withDeleted: false }),
  ]);

  const $t = await getFormatter();

  return {
    configuration,
    health,
    deletion,
    replicas,
    databaseBackups,
    storageExport,
    users,
    meta: {
      title: $t('admin.storage'),
    },
  };
}) satisfies PageLoad;
