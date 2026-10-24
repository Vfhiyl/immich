<script lang="ts">
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { ResourceCheckLevel, type ResourceCheckResponseDto } from '@immich/sdk';
  import { Stack, Text } from '@immich/ui';
  import { t } from 'svelte-i18n';

  type Props = {
    check: ResourceCheckResponseDto;
  };

  const { check }: Props = $props();

  const colors = {
    [ResourceCheckLevel.Ok]: 'success',
    [ResourceCheckLevel.BelowRecommended]: 'warning',
    [ResourceCheckLevel.BelowMinimum]: 'danger',
  } as const;

  const size = (bytes: number) => getByteUnitString(bytes);
  const below = (level: ResourceCheckLevel, minimum: string, recommended?: string) => {
    if (level === ResourceCheckLevel.BelowMinimum) {
      return ` (${$t('admin.resource_check_below_minimum', { values: { value: minimum } })})`;
    }
    if (level === ResourceCheckLevel.BelowRecommended && recommended) {
      return ` (${$t('admin.resource_check_below_recommended', { values: { value: recommended } })})`;
    }
    return '';
  };
  const { requirements } = $derived(check);
</script>

<Stack gap={1} class="text-start">
  <Text fontWeight="semi-bold">{$t('admin.resource_check')}</Text>
  <Text size="small" color="muted">{$t('admin.resource_check_description')}</Text>
  <Text size="small" color={colors[check.memory.level]} data-testid="resource-memory">
    {$t('admin.resource_check_memory', { values: { size: size(check.memory.bytes) } })}{below(
      check.memory.level,
      size(requirements.memoryMinimum),
      size(requirements.memoryRecommended),
    )}
  </Text>
  <Text size="small" color={colors[check.cpus.level]} data-testid="resource-cpus">
    {$t('admin.resource_check_cpus', { values: { count: check.cpus.cores } })}{below(
      check.cpus.level,
      String(requirements.cpusMinimum),
      String(requirements.cpusRecommended),
    )}
  </Text>
  <Text size="small" color={colors[check.disk.level]} data-testid="resource-disk">
    {$t('admin.resource_check_disk', { values: { path: check.disk.path, size: size(check.disk.free) } })}{below(
      check.disk.level,
      size(requirements.diskMinimum),
    )}
  </Text>
  {#if !check.machineLearning.enabled}
    <Text size="small" color="muted">{$t('admin.resource_check_ml_disabled')}</Text>
  {/if}
  {#each check.machineLearning.services as service (service.url)}
    {#if !service.reachable}
      <Text size="small" color="danger">
        {$t('admin.resource_check_ml_unreachable', { values: { url: service.url } })}
      </Text>
    {:else if service.memory}
      <Text size="small" color="success">
        {$t('admin.resource_check_ml_reachable', {
          values: { url: service.url, size: `${size(service.memory.used)} / ${size(service.memory.limit)}` },
        })}
      </Text>
    {:else}
      <Text size="small" color="success">
        {$t('admin.resource_check_ml_reachable_unknown', { values: { url: service.url } })}
      </Text>
    {/if}
  {/each}
</Stack>
