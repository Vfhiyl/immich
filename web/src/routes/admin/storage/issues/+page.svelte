<script lang="ts">
  import AdminPageLayout from '$lib/components/layouts/AdminPageLayout.svelte';
  import { Route } from '$lib/route';
  import { formatAge, handleAcknowledgeStorageIssue } from '$lib/services/storage.service';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { getBaseUrl, getStorageIssues } from '@immich/sdk';
  import {
    Button,
    Container,
    HStack,
    Select,
    Table,
    TableBody,
    TableCell,
    TableHeader,
    TableHeading,
    TableRow,
    Text,
  } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  type Props = {
    data: PageData;
  };

  const { data }: Props = $props();

  type Status = 'open' | 'resolved' | 'all';
  let status = $state<Status>('open');
  let issues = $state(data.issues);

  const statusOptions = $derived([
    { value: 'open' as const, label: $t('admin.storage_issues_open') },
    { value: 'resolved' as const, label: $t('admin.storage_issues_resolved') },
    { value: 'all' as const, label: $t('all') },
  ]);

  const onStatusChange = async (value: Status) => {
    status = value;
    issues = await getStorageIssues({ status });
  };

  const loadMore = async () => {
    const { items, nextCursor } = await getStorageIssues({ status, cursor: issues.nextCursor });
    issues.items.push(...items);
    issues.nextCursor = nextCursor;
  };

  const onAcknowledge = async (id: string) => {
    if (await handleAcknowledgeStorageIssue(id)) {
      const issue = issues.items.find((issue) => issue.id === id);
      if (issue) {
        issue.acknowledgedAt = new Date().toISOString();
      }
    }
  };
</script>

<AdminPageLayout breadcrumbs={[{ title: $t('admin.storage'), href: Route.storage() }, { title: data.meta.title }]}>
  <Container size="large" center class="my-4 flex flex-col gap-8 pb-28">
    <section>
      <HStack class="justify-between">
        <Text size="large" fontWeight="semi-bold">{$t('admin.storage_issues')}</Text>
        <HStack gap={2}>
          <Select options={statusOptions} value={status} onChange={onStatusChange} class="w-fit min-w-40" />
          <Button size="small" variant="ghost" href={`${getBaseUrl()}/admin/storage/checks/issues/csv`}>
            {$t('export')}
          </Button>
        </HStack>
      </HStack>
      <Table striped spacing="tiny" class="mt-3">
        <TableHeader>
          <TableHeading>{$t('admin.storage_backend')}</TableHeading>
          <TableHeading>{$t('admin.storage_issue_file')}</TableHeading>
          <TableHeading>{$t('admin.storage_issue_kind')}</TableHeading>
          <TableHeading>{$t('admin.storage_issue_seen')}</TableHeading>
          <TableHeading />
        </TableHeader>
        <TableBody>
          {#each issues.items as issue (issue.id)}
            <TableRow>
              <TableCell>{issue.backendId}</TableCell>
              <TableCell class="break-all">
                {issue.key}
                {#if issue.detail}<Text size="tiny" color="muted">{issue.detail}</Text>{/if}
              </TableCell>
              <TableCell>{issue.kind}</TableCell>
              <TableCell>
                {formatAge(issue.firstSeenAt)}
                {#if issue.resolvedAt}<Text size="tiny" color="success">{$t('admin.storage_issue_resolved')}</Text>{/if}
              </TableCell>
              <TableCell>
                {#if issue.acknowledgedAt}
                  <Text size="tiny" color="muted">{$t('admin.storage_issue_acknowledged')}</Text>
                {:else if !issue.resolvedAt}
                  <Button size="tiny" variant="ghost" onclick={() => onAcknowledge(issue.id)}>
                    {$t('admin.storage_issue_acknowledge')}
                  </Button>
                {/if}
              </TableCell>
            </TableRow>
          {:else}
            <TableRow><TableCell>{$t('admin.storage_no_issues')}</TableCell></TableRow>
          {/each}
        </TableBody>
      </Table>
      {#if issues.nextCursor}
        <div class="mt-4 flex justify-center">
          <Button size="medium" color="secondary" onclick={() => loadMore()}>{$t('load_more')}</Button>
        </div>
      {/if}
    </section>

    <section>
      <Text size="large" fontWeight="semi-bold">{$t('admin.storage_runs')}</Text>
      <Table striped spacing="tiny" class="mt-3">
        <TableHeader>
          <TableHeading>{$t('admin.storage_run_kind')}</TableHeading>
          <TableHeading>{$t('admin.storage_run_status')}</TableHeading>
          <TableHeading>{$t('admin.storage_run_started')}</TableHeading>
          <TableHeading>{$t('admin.storage_run_checked')}</TableHeading>
          <TableHeading>{$t('admin.storage_run_new_issues')}</TableHeading>
        </TableHeader>
        <TableBody>
          {#each data.runs as run (run.id)}
            <TableRow>
              <TableCell>{run.kind}</TableCell>
              <TableCell>
                {run.status}
                {#if run.stoppedBecause}<Text size="tiny" color="muted">{run.stoppedBecause}</Text>{/if}
              </TableCell>
              <TableCell>{formatAge(run.startedAt)}</TableCell>
              <TableCell>{run.checked} · {getByteUnitString(run.bytes)}</TableCell>
              <TableCell>{run.newIssues}</TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    </section>
  </Container>
</AdminPageLayout>
