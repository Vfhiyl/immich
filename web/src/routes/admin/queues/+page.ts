import { getMachineLearningModels, getQueues } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url, { admin: true });

  const [queues, models] = await Promise.all([getQueues(), getMachineLearningModels()]);
  const $t = await getFormatter();

  return {
    queues,
    models,
    meta: {
      title: $t('admin.queues'),
    },
  };
}) satisfies PageLoad;
