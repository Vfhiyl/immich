<script lang="ts">
  import AdminPageLayout from '$lib/components/layouts/AdminPageLayout.svelte';
  import { Route } from '$lib/route';
  import { FAILURES_PAGE_SIZE, failureRate, historySeries, JOB_HISTORY_RANGES } from '$lib/utils/job-history';
  import { JobFailureCategory } from '@immich/sdk';
  import {
    Alert,
    Button,
    Card,
    CardBody,
    CardHeader,
    Container,
    HStack,
    Link,
    Stack,
    Table,
    TableBody,
    TableCell,
    TableHeader,
    TableHeading,
    TableRow,
    Text,
  } from '@immich/ui';
  import { DateTime } from 'luxon';
  import { t, type Translations } from 'svelte-i18n';
  import type { PageData } from './$types';
  import JobHistoryChart from './JobHistoryChart.svelte';

  type Props = {
    data: PageData;
  };

  const { data }: Props = $props();
  const { history, failures, range, filter, page } = $derived(data);

  const ranges: Record<(typeof JOB_HISTORY_RANGES)[number], Translations> = {
    today: 'admin.job_history_today',
    '3d': 'admin.job_history_3_days',
    '7d': 'admin.job_history_7_days',
    '30d': 'admin.job_history_30_days',
    '365d': 'admin.job_history_365_days',
    all: 'admin.job_history_all',
  };
  const categories: Record<JobFailureCategory, Translations> = {
    [JobFailureCategory.File]: 'admin.job_history_category_file',
    [JobFailureCategory.Stuck]: 'admin.job_history_category_stuck',
    [JobFailureCategory.OutOfMemory]: 'admin.job_history_category_out_of_memory',
    [JobFailureCategory.Environment]: 'admin.job_history_category_environment',
  };

  const rate = (runs: { succeeded: number; failed: number }) => {
    const value = failureRate(runs);
    return value === null ? '–' : `${value}%`;
  };
  const when = (iso: string) => DateTime.fromISO(iso).toLocaleString(DateTime.DATETIME_SHORT);
  /** The page with these filters (and the range kept), the first page of them unless told */
  const href = (params: { jobName?: string; category?: string; reason?: string; page?: number }) =>
    Route.jobHistory({ range, ...params });
  const pages = $derived(Math.max(1, Math.ceil(failures.total / FAILURES_PAGE_SIZE)));
  const filtered = $derived(!!(filter.jobName || filter.category || filter.reason));
</script>

<AdminPageLayout breadcrumbs={[{ title: $t('admin.queues'), href: Route.queues() }, { title: data.meta.title }]}>
  <Container size="large" center class="my-4 flex flex-col gap-6 pb-28">
    <HStack class="justify-between" wrap>
      <Text size="small" color="muted">{$t('admin.job_history_description')}</Text>
      <HStack gap={1}>
        {#each JOB_HISTORY_RANGES as option (option)}
          <Button
            size="small"
            variant={option === range ? 'filled' : 'ghost'}
            href={Route.jobHistory({ range: option, ...filter })}
            data-testid="job-history-range-{option}"
          >
            {$t(ranges[option])}
          </Button>
        {/each}
      </HStack>
    </HStack>

    {#each history.alerts as alert (alert.jobName)}
      <Alert
        color="danger"
        title={$t('admin.job_history_alert', {
          values: {
            job: alert.jobName,
            failed: alert.failed,
            runs: alert.runs,
            usual: alert.usualRate === null ? '–' : `${Math.round(alert.usualRate * 1000) / 10}%`,
          },
        })}
      />
    {/each}

    <Card>
      <CardHeader>
        <HStack gap={8} wrap>
          <Text data-testid="job-history-totals">
            {$t('admin.job_history_totals', {
              values: {
                succeeded: history.totals.succeeded,
                failed: history.totals.failed,
                rate: rate(history.totals),
                retried: history.totals.retried,
              },
            })}
          </Text>
        </HStack>
      </CardHeader>
      <CardBody>
        <Stack gap={4}>
          {#if history.series.length > 0}
            <JobHistoryChart
              series={historySeries(history.series)}
              hourly={history.unit === 'hour'}
              succeededLabel={$t('admin.job_history_succeeded')}
              failedLabel={$t('admin.job_history_failed')}
            />
          {/if}
          {#if history.jobs.length > 0}
            <Table striped spacing="tiny">
              <TableHeader>
                <TableHeading>{$t('admin.job_history_job')}</TableHeading>
                <TableHeading>{$t('admin.job_history_succeeded')}</TableHeading>
                <TableHeading>{$t('admin.job_history_failed')}</TableHeading>
                <TableHeading>{$t('admin.job_history_rate')}</TableHeading>
                <TableHeading>{$t('admin.job_history_retried')}</TableHeading>
              </TableHeader>
              <TableBody>
                {#each history.jobs as job (job.jobName)}
                  <TableRow>
                    <TableCell>{job.jobName}</TableCell>
                    <TableCell>{job.succeeded}</TableCell>
                    <TableCell>
                      {#if job.failed > 0}
                        <Link href={href({ jobName: job.jobName })}>{job.failed}</Link>
                      {:else}
                        0
                      {/if}
                    </TableCell>
                    <TableCell>{rate(job)}</TableCell>
                    <TableCell>{job.retried}</TableCell>
                  </TableRow>
                {/each}
              </TableBody>
            </Table>
          {:else}
            <Text color="muted">{$t('admin.job_history_none')}</Text>
          {/if}
        </Stack>
      </CardBody>
    </Card>

    {#if history.reasons.length > 0}
      <Card>
        <CardHeader><Text fontWeight="semi-bold">{$t('admin.job_history_reasons')}</Text></CardHeader>
        <CardBody>
          <Table striped spacing="tiny">
            <TableHeader>
              <TableHeading>{$t('admin.job_history_job')}</TableHeading>
              <TableHeading>{$t('admin.job_history_category')}</TableHeading>
              <TableHeading>{$t('admin.job_history_reason')}</TableHeading>
              <TableHeading>{$t('admin.job_history_count')}</TableHeading>
              <TableHeading>{$t('admin.job_history_last')}</TableHeading>
            </TableHeader>
            <TableBody>
              {#each history.reasons as reason (`${reason.jobName}|${reason.category}|${reason.reason}`)}
                <TableRow>
                  <TableCell>{reason.jobName}</TableCell>
                  <TableCell>{$t(categories[reason.category])}</TableCell>
                  <TableCell>
                    <Link href={href({ jobName: reason.jobName, category: reason.category, reason: reason.reason })}>
                      {reason.reason}
                    </Link>
                  </TableCell>
                  <TableCell>{reason.count}</TableCell>
                  <TableCell>{when(reason.lastAt)}</TableCell>
                </TableRow>
              {/each}
            </TableBody>
          </Table>
        </CardBody>
      </Card>
    {/if}

    <Card>
      <CardHeader>
        <HStack class="justify-between" wrap>
          <Text fontWeight="semi-bold" data-testid="job-history-failures-title">
            {$t('admin.job_history_failures', { values: { count: failures.total } })}
          </Text>
          {#if filtered}
            <HStack gap={2}>
              <Text size="small" color="muted">
                {[filter.jobName, filter.category && $t(categories[filter.category]), filter.reason]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
              <Button size="small" variant="ghost" href={href({})}>{$t('admin.job_history_all_failures')}</Button>
            </HStack>
          {/if}
        </HStack>
      </CardHeader>
      <CardBody>
        <Stack gap={2}>
          {#each failures.items as item (item.id)}
            <div class="flex flex-col" data-testid="job-history-failure">
              <Text size="small">
                {when(item.createdAt)} · {item.jobName} · {$t(categories[item.category])}
                {#if item.assetId && item.originalFileName}
                  · <Link href="/photos/{item.assetId}">{item.originalFileName}</Link>
                {/if}
              </Text>
              <Text size="small" color="muted" class="break-all">{item.error}</Text>
            </div>
          {/each}
          {#if pages > 1}
            <HStack gap={2} class="justify-center">
              {#if page > 1}
                <Button size="small" variant="ghost" href={href({ ...filter, page: page - 1 })}>{$t('previous')}</Button
                >
              {/if}
              <Text size="small">{$t('admin.job_history_page', { values: { page, pages } })}</Text>
              {#if page < pages}
                <Button size="small" variant="ghost" href={href({ ...filter, page: page + 1 })}>{$t('next')}</Button>
              {/if}
            </HStack>
          {/if}
        </Stack>
      </CardBody>
    </Card>
  </Container>
</AdminPageLayout>
