import { authenticate } from '#lib/utils/auth.ts';
import { getFormatter } from '#lib/utils/i18n.ts';
import { rangeOf, toUsageRange } from '#lib/utils/storage-usage.ts';
import { getStorageUsage } from '@immich/sdk';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url, { admin: true });

  const days = toUsageRange(url.searchParams.get('days'));
  const { from, to } = rangeOf(days);
  const usage = await getStorageUsage({ $from: from, to });
  const $t = await getFormatter();

  return {
    days,
    usage,
    meta: {
      title: $t('admin.storage_usage'),
    },
  };
}) satisfies PageLoad;
