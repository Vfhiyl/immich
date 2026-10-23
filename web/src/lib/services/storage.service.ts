import {
  acknowledgeStorageIssue,
  cancelStorageExport,
  fetchStoredDatabaseBackup,
  importDeletedOriginal,
  purgeDeletedOriginal,
  resumeStorageDeletion,
  retryStorageReplicaCopies,
  StorageCheckKind,
  startStorageCheck,
  startStorageExport,
} from '@immich/sdk';
import { toastManager } from '@immich/ui';
import { DateTime } from 'luxon';
import { handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';

/** How long ago a time was, in the largest unit that fits, e.g. "3 hours"; null for none */
export const formatAge = (iso: string | null | undefined, now: DateTime = DateTime.now()) => {
  if (!iso) {
    return null;
  }
  return DateTime.fromISO(iso).toRelative({ base: now, style: 'long' });
};

/** The share of `part` in `total`, as a whole percentage; 100 when there is nothing to do */
export const toPercent = (part: number, total: number) =>
  total <= 0 ? 100 : Math.min(100, Math.floor((part / total) * 100));

export const handleStartStorageCheck = async (kind: StorageCheckKind) => {
  const $t = await getFormatter();
  try {
    await startStorageCheck({ storageCheckStartDto: { kind } });
    toastManager.info($t('admin.storage_check_started'));
    return true;
  } catch (error) {
    handleError(error, $t('errors.unable_to_start_storage_check'));
    return false;
  }
};

export const handleStartStorageExport = async (userIds?: string[]) => {
  const $t = await getFormatter();
  try {
    await startStorageExport({ storageExportStartDto: { userIds } });
    toastManager.info($t('admin.storage_export_started'));
    return true;
  } catch (error) {
    handleError(error, $t('errors.unable_to_start_storage_export'));
    return false;
  }
};

export const handleCancelStorageExport = async () => {
  const $t = await getFormatter();
  try {
    await cancelStorageExport();
    return true;
  } catch (error) {
    handleError(error, $t('errors.unable_to_cancel_storage_export'));
    return false;
  }
};

export const handleAcknowledgeStorageIssue = async (id: string) => {
  const $t = await getFormatter();
  try {
    await acknowledgeStorageIssue({ id });
    return true;
  } catch (error) {
    handleError(error, $t('errors.unable_to_acknowledge_storage_issue'));
    return false;
  }
};

export const handleRetryReplicaCopies = async (id: string) => {
  const $t = await getFormatter();
  try {
    const { count } = await retryStorageReplicaCopies({ id });
    toastManager.info($t('admin.storage_replica_retried', { values: { count } }));
    return true;
  } catch (error) {
    handleError(error, $t('errors.unable_to_retry_replica_copies'));
    return false;
  }
};

export const handleResumeStorageDeletion = async () => {
  const $t = await getFormatter();
  try {
    await resumeStorageDeletion();
    toastManager.info($t('admin.storage_deletion_resumed'));
    return true;
  } catch (error) {
    handleError(error, $t('errors.unable_to_resume_storage_deletion'));
    return false;
  }
};

export const handleFetchStoredDatabaseBackup = async (key: string) => {
  const $t = await getFormatter();
  try {
    const { filename } = await fetchStoredDatabaseBackup({ key });
    toastManager.info($t('admin.storage_database_backup_fetched', { values: { filename } }));
    return true;
  } catch (error) {
    handleError(error, $t('errors.unable_to_fetch_database_backup'));
    return false;
  }
};

/** Imports a deleted original as a new photo, of its owner or of `userId` */
export const handleImportDeletedOriginal = async (id: string, userId?: string) => {
  const $t = await getFormatter();
  try {
    await importDeletedOriginal({ id, storageDeletionImportDto: userId ? { userId } : {} });
    toastManager.info($t('admin.storage_deleted_original_imported'));
    return true;
  } catch (error) {
    handleError(error, $t('errors.unable_to_import_deleted_original'));
    return false;
  }
};

export const handlePurgeDeletedOriginal = async (id: string, password: string) => {
  const $t = await getFormatter();
  try {
    await purgeDeletedOriginal({ id, storageDeletionPurgeDto: { password } });
    toastManager.info($t('admin.storage_deleted_original_purged'));
    return true;
  } catch (error) {
    handleError(error, $t('errors.unable_to_purge_deleted_original'));
    return false;
  }
};
