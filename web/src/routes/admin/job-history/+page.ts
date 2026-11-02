import { getJobFailureLog, getJobHistory, type JobFailureCategory } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import { FAILURES_PAGE_SIZE, sinceOf, toJobHistoryRange } from '$lib/utils/job-history';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url, { admin: true });

  const range = toJobHistoryRange(url.searchParams.get('range'));
  const since = sinceOf(range);
  const filter = {
    jobName: url.searchParams.get('jobName') ?? undefined,
    category: (url.searchParams.get('category') ?? undefined) as JobFailureCategory | undefined,
    reason: url.searchParams.get('reason') ?? undefined,
  };
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const [history, failures] = await Promise.all([
    getJobHistory({ since }),
    getJobFailureLog({ since, ...filter, page, size: FAILURES_PAGE_SIZE }),
  ]);
  const $t = await getFormatter();

  return {
    range,
    filter,
    page,
    history,
    failures,
    meta: {
      title: $t('admin.job_history'),
    },
  };
}) satisfies PageLoad;
