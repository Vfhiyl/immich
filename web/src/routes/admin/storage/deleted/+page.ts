import { getDeletedOriginals, searchUsersAdmin } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url, { admin: true });

  const [originals, users] = await Promise.all([getDeletedOriginals({}), searchUsersAdmin({ withDeleted: true })]);
  const $t = await getFormatter();

  return {
    originals,
    users,
    meta: {
      title: $t('admin.storage_deleted_originals'),
    },
  };
}) satisfies PageLoad;
