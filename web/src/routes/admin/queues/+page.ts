import { authenticate } from '#lib/utils/auth.ts';
import { getFormatter } from '#lib/utils/i18n.ts';
import {
  getJobFailures,
  getJobHistory,
  getMachineLearningModels,
  getProcessing,
  getQueues,
  getResourceCheck,
} from '@immich/sdk';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url, { admin: true });

  const [queues, models, resources, failures, history, processing] = await Promise.all([
    getQueues(),
    getMachineLearningModels(),
    // only shown when it can be read
    getResourceCheck().catch(() => null),
    getJobFailures(),
    // the jobs that failed far more often than usual in the last 24 hours
    getJobHistory({ since: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() }).catch(() => null),
    // how far the library is processed, step by step
    getProcessing().catch(() => null),
  ]);
  const $t = await getFormatter();

  return {
    queues,
    models,
    resources,
    failures,
    processing,
    alerts: history?.alerts ?? [],
    meta: {
      title: $t('admin.queues'),
    },
  };
}) satisfies PageLoad;
