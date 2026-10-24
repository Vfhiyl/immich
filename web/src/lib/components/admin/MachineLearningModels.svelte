<script lang="ts">
  import { formatAge, toPercent } from '$lib/services/storage.service';
  import type { MachineLearningModelDto, MachineLearningTaskModelsDto } from '@immich/sdk';
  import { Alert, Stack, Text } from '@immich/ui';
  import { t, type Translations } from 'svelte-i18n';

  type Props = {
    tasks: MachineLearningTaskModelsDto[];
  };

  const { tasks }: Props = $props();

  const titles = new Map<string, Translations>([
    ['clip', 'admin.machine_learning_models_task_clip'],
    ['facial-recognition', 'admin.machine_learning_models_task_facial_recognition'],
    ['ocr', 'admin.machine_learning_models_task_ocr'],
  ]);
  const title = (task: string) => {
    const key = titles.get(task);
    return key ? $t(key) : task;
  };

  const short = (fingerprint: string | null) => fingerprint?.slice(0, 12) ?? '?';

  const files = (model: MachineLearningModelDto) =>
    model.fingerprint
      ? $t('admin.machine_learning_models_files', {
          values: { fingerprint: short(model.fingerprint), format: model.format ?? '?' },
        })
      : $t('admin.machine_learning_models_files_unknown');
</script>

<section data-testid="ml-models">
  <Text size="large" fontWeight="semi-bold">{$t('admin.machine_learning_models')}</Text>
  <Text size="small" color="muted" class="mb-3">{$t('admin.machine_learning_models_description')}</Text>
  <Stack gap={4}>
    {#each tasks as task (task.task)}
      <div class="flex flex-col gap-1" data-testid="ml-task-{task.task}">
        <Text fontWeight="bold">{title(task.task)}</Text>
        {#if !task.enabled}
          <Text size="small" color="muted">{$t('admin.machine_learning_models_disabled')}</Text>
        {:else}
          <Text size="small">{task.target.name} · {files(task.target)}</Text>
          {#if task.active && task.active.name !== task.target.name}
            <Text size="small">
              {$t('admin.machine_learning_models_searched', {
                values: { name: task.active.name, target: task.target.name },
              })}
            </Text>
          {/if}
          {#if task.rebuild && !task.rebuild.finishedAt}
            {@const total = task.rebuild.total ?? 0}
            {@const done = task.rebuild.done ?? 0}
            <Text size="small">{$t('admin.machine_learning_models_rebuilding', { values: { done, total } })}</Text>
            <div class="h-1.5 w-full rounded-full bg-gray-200 dark:bg-gray-700">
              <div class="h-1.5 rounded-full bg-primary" style:width="{toPercent(done, total)}%"></div>
            </div>
          {:else if task.rebuild?.finishedAt}
            <Text size="small" color="muted">
              {$t('admin.machine_learning_models_rebuilt', { values: { age: formatAge(task.rebuild.finishedAt) } })}
            </Text>
          {/if}
          {#if task.conflict}
            <Alert
              color="danger"
              size="small"
              title={$t('admin.machine_learning_models_conflict', {
                values: { age: formatAge(task.conflict.at), fingerprint: short(task.conflict.model.fingerprint) },
              })}
            />
          {/if}
          {#if task.replaced}
            <Alert
              color="warning"
              size="small"
              title={$t('admin.machine_learning_models_replaced', {
                values: {
                  age: formatAge(task.replaced.at),
                  from: short(task.replaced.from.fingerprint),
                  to: short(task.replaced.to.fingerprint),
                },
              })}
            />
          {/if}
        {/if}
      </div>
    {/each}
  </Stack>
</section>
