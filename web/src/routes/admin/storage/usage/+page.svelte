<script lang="ts">
  import AdminPageLayout from '$lib/components/layouts/AdminPageLayout.svelte';
  import { Route } from '$lib/route';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { budgetShares, summarizeUsage, USAGE_RANGES, usageSeries } from '$lib/utils/storage-usage';
  import type { StorageCostDto } from '@immich/sdk';
  import {
    Alert,
    Button,
    Card,
    CardBody,
    CardHeader,
    Container,
    HStack,
    Stack,
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
  import StorageUsageChart from './StorageUsageChart.svelte';

  type Props = {
    data: PageData;
  };

  const { data }: Props = $props();

  const formatCost = (cost: StorageCostDto | null | undefined) =>
    cost ? `${cost.total.toFixed(2)} ${cost.currency}` : '–';
  const formatAmount = (amount: number, currency: string) => `${amount.toFixed(2)} ${currency}`;
</script>

<AdminPageLayout breadcrumbs={[{ title: $t('admin.storage'), href: Route.storage() }, { title: data.meta.title }]}>
  <Container size="large" center class="my-4 flex flex-col gap-6 pb-28">
    <HStack class="justify-between">
      <Text size="small" color="muted">
        {$t('admin.storage_usage_description', { values: { from: data.usage.from, to: data.usage.to } })}
      </Text>
      <HStack gap={1}>
        {#each USAGE_RANGES as days (days)}
          <Button
            size="small"
            variant={days === data.days ? 'filled' : 'ghost'}
            href={`${Route.storageUsage()}?days=${days}`}
          >
            {$t('admin.storage_usage_days', { values: { days } })}
          </Button>
        {/each}
      </HStack>
    </HStack>

    {#if data.usage.backends.length === 0}
      <Alert color="info" title={$t('admin.storage_no_backends')} />
    {/if}

    {#each data.usage.backends as backend (backend.backendId)}
      {@const summary = summarizeUsage(backend)}
      <Card>
        <CardHeader>
          <HStack class="justify-between">
            <Text size="large" fontWeight="semi-bold">{backend.backendId}</Text>
            <Text>{$t('admin.storage_usage_cost', { values: { cost: formatCost(backend.cost) } })}</Text>
          </HStack>
        </CardHeader>
        <CardBody>
          <Stack gap={4}>
            {#if backend.budget}
              {@const shares = budgetShares(backend.budget)}
              <Alert
                color={shares.isOver ? 'danger' : shares.willBeOver ? 'warning' : 'success'}
                title={$t('admin.storage_usage_budget', {
                  values: {
                    month: backend.budget.month,
                    spent: formatAmount(backend.budget.monthToDate, backend.budget.currency),
                    projected: formatAmount(backend.budget.projected, backend.budget.currency),
                    amount: formatAmount(backend.budget.amount, backend.budget.currency),
                    share: shares.projected,
                  },
                })}
              />
            {/if}
            <HStack gap={8} wrap>
              <Text size="small">
                {$t('admin.storage_usage_stored', {
                  values: { size: getByteUnitString(summary.storedBytes), objects: summary.storedObjects },
                })}
              </Text>
              <Text size="small">
                {$t('admin.storage_usage_requests', {
                  values: {
                    write: summary.requests.write,
                    read: summary.requests.read,
                    delete: summary.requests.delete,
                  },
                })}
              </Text>
              <Text size="small">
                {$t('admin.storage_usage_traffic', {
                  values: {
                    sent: getByteUnitString(summary.bytesSent),
                    received: getByteUnitString(summary.bytesReceived),
                  },
                })}
              </Text>
            </HStack>
            {#if backend.days.length > 0}
              <StorageUsageChart
                series={usageSeries(backend)}
                storedLabel={$t('admin.storage_usage_chart_stored')}
                costLabel={$t('admin.storage_usage_chart_cost')}
              />
            {/if}
            {#if backend.purposes.length > 0}
              <Table striped spacing="tiny">
                <TableHeader>
                  <TableHeading>{$t('admin.storage_usage_purpose')}</TableHeading>
                  <TableHeading>{$t('admin.storage_usage_write')}</TableHeading>
                  <TableHeading>{$t('admin.storage_usage_read')}</TableHeading>
                  <TableHeading>{$t('admin.storage_usage_delete')}</TableHeading>
                  <TableHeading>{$t('admin.storage_usage_received')}</TableHeading>
                  <TableHeading>{$t('admin.storage_usage_estimate')}</TableHeading>
                </TableHeader>
                <TableBody>
                  {#each backend.purposes as purpose (purpose.purpose)}
                    <TableRow>
                      <TableCell>{purpose.purpose}</TableCell>
                      <TableCell>{purpose.requests.write}</TableCell>
                      <TableCell>{purpose.requests.read}</TableCell>
                      <TableCell>{purpose.requests.delete}</TableCell>
                      <TableCell>{getByteUnitString(purpose.bytesReceived)}</TableCell>
                      <TableCell>{formatCost(purpose.cost)}</TableCell>
                    </TableRow>
                  {/each}
                </TableBody>
              </Table>
            {/if}
          </Stack>
        </CardBody>
      </Card>
    {/each}
  </Container>
</AdminPageLayout>
