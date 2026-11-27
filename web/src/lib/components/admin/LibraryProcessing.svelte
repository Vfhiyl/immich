<script lang="ts">
  import { toPercent } from '#lib/services/storage.service.ts';
  import { ProcessingStep, QueueName, type ProcessingStepDto, type QueueResponseDto } from '@immich/sdk';
  import { Stack, Text } from '@immich/ui';
  import { t, type Translations } from 'svelte-i18n';

  type Props = {
    steps: ProcessingStepDto[];
    /** The queues, to tell whether what is left waits in one */
    queues?: QueueResponseDto[];
  };

  const { steps, queues = [] }: Props = $props();

  const stepQueues: Record<ProcessingStep, QueueName> = {
    [ProcessingStep.Metadata]: QueueName.MetadataExtraction,
    [ProcessingStep.Thumbnails]: QueueName.ThumbnailGeneration,
    [ProcessingStep.SmartSearch]: QueueName.SmartSearch,
    [ProcessingStep.Faces]: QueueName.FaceDetection,
    [ProcessingStep.Ocr]: QueueName.Ocr,
    [ProcessingStep.Duplicates]: QueueName.DuplicateDetection,
  };

  const titles: Record<ProcessingStep, Translations> = {
    [ProcessingStep.Metadata]: 'admin.processing_step_metadata',
    [ProcessingStep.Thumbnails]: 'admin.processing_step_thumbnails',
    [ProcessingStep.SmartSearch]: 'admin.processing_step_smart_search',
    [ProcessingStep.Faces]: 'admin.processing_step_faces',
    [ProcessingStep.Ocr]: 'admin.processing_step_ocr',
    [ProcessingStep.Duplicates]: 'admin.processing_step_duplicates',
  };

  /** What is left of a step, how fast it went lately, and when it may be done at that pace */
  const status = ({ step, total, done, perHour }: ProcessingStepDto) => {
    const left = total - done;
    if (left <= 0) {
      return $t('admin.processing_complete');
    }
    const parts = [$t('admin.processing_left', { values: { left } })];
    if (perHour <= 0) {
      // why nothing moves: its queue is paused, its jobs fail, or nothing was queued for them
      const queue = queues.find(({ name }) => name === stepQueues[step]);
      const queued = queue
        ? queue.statistics.active + queue.statistics.waiting + queue.statistics.delayed + queue.statistics.paused
        : 0;
      if (queue?.isPaused) {
        parts.push($t('admin.processing_paused'));
      } else if (queued > 0) {
        parts.push($t('admin.processing_queued', { values: { count: queued } }), $t('admin.processing_stalled'));
      } else {
        parts.push($t('admin.processing_not_queued'));
      }
      return parts.join(' · ');
    }
    parts.push($t('admin.processing_rate', { values: { rate: perHour } }));
    const hours = left / perHour;
    parts.push(
      hours < 1
        ? $t('admin.processing_eta_minutes', { values: { minutes: Math.max(1, Math.round(hours * 60)) } })
        : hours < 48
          ? $t('admin.processing_eta_hours', { values: { hours: Math.round(hours) } })
          : $t('admin.processing_eta_days', { values: { days: Math.round(hours / 24) } }),
    );
    return parts.join(' · ');
  };
</script>

<section data-testid="library-processing">
  <Text size="large" fontWeight="semi-bold">{$t('admin.processing')}</Text>
  <Text size="small" color="muted" class="mb-3">{$t('admin.processing_description')}</Text>
  <Stack gap={3}>
    {#each steps as step (step.step)}
      <div class="flex flex-col gap-1" data-testid="processing-{step.step}">
        <div class="flex justify-between gap-2">
          <Text fontWeight="bold">{$t(titles[step.step])}</Text>
          {#if step.enabled}
            <Text size="small">
              {$t('admin.processing_done_of', { values: { done: step.done, total: step.total } })}
              ({toPercent(step.done, step.total)}%)
            </Text>
          {/if}
        </div>
        {#if step.enabled}
          <div class="h-1.5 w-full rounded-full bg-gray-200 dark:bg-gray-700">
            <div class="h-1.5 rounded-full bg-primary" style:width="{toPercent(step.done, step.total)}%"></div>
          </div>
          <Text size="small" color="muted">{status(step)}</Text>
        {:else}
          <Text size="small" color="muted">{$t('admin.processing_disabled')}</Text>
        {/if}
      </div>
    {/each}
  </Stack>
</section>
