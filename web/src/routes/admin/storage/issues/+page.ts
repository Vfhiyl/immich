import { authenticate } from '#lib/utils/auth.ts';
import { getFormatter } from '#lib/utils/i18n.ts';
import { getStorageCheckRuns, getStorageIssues } from '@immich/sdk';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url, { admin: true });

  const [issues, runs] = await Promise.all([getStorageIssues({ status: 'open' }), getStorageCheckRuns({ limit: 20 })]);
  const $t = await getFormatter();

  return {
    issues,
    runs,
    meta: {
      title: $t('admin.storage_reports'),
    },
  };
}) satisfies PageLoad;
