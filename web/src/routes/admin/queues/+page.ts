import { getMachineLearningModels, getQueues, getResourceCheck } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url, { admin: true });

  const [queues, models, resources] = await Promise.all([
    getQueues(),
    getMachineLearningModels(),
    // only shown when it can be read
    getResourceCheck().catch(() => null),
  ]);
  const $t = await getFormatter();

  return {
    queues,
    models,
    resources,
    meta: {
      title: $t('admin.queues'),
    },
  };
}) satisfies PageLoad;
