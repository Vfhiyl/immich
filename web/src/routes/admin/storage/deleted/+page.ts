import { authenticate } from '#lib/utils/auth.ts';
import { getFormatter } from '#lib/utils/i18n.ts';
import { getDeletedOriginals, searchUsersAdmin } from '@immich/sdk';
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
