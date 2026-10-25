<script lang="ts">
  import { formatAge } from '$lib/services/storage.service';
  import { handleError } from '$lib/utils/handle-error';
  import { retryJobFailures, TrackedJobName, type JobFailuresResponseDto } from '@immich/sdk';
  import { Button, Link, Stack, Text, toastManager } from '@immich/ui';
  import { t, type Translations } from 'svelte-i18n';

  type Props = {
    failures: JobFailuresResponseDto;
    /** After files were queued again, to show it */
    onChange?: () => void;
  };

  const { failures, onChange }: Props = $props();

  const titles: Record<TrackedJobName, Translations> = {
    [TrackedJobName.AssetExtractMetadata]: 'admin.metadata_extraction_job',
    [TrackedJobName.AssetGenerateThumbnails]: 'admin.thumbnail_generation_job',
    [TrackedJobName.AssetEncodeVideo]: 'admin.video_conversion_job',
    [TrackedJobName.SmartSearch]: 'admin.machine_learning_smart_search',
    [TrackedJobName.AssetDetectFaces]: 'admin.face_detection',
    [TrackedJobName.Ocr]: 'admin.machine_learning_ocr',
  };

  const onRetry = async (jobName: TrackedJobName) => {
    try {
      const { count } = await retryJobFailures({ jobFailureRetryDto: { jobName } });
      toastManager.primary($t('admin.job_failures_retried', { values: { job: $t(titles[jobName]), count } }));
      onChange?.();
    } catch (error) {
      handleError(error, $t('errors.cant_apply_changes'));
    }
  };
</script>

<section data-testid="job-failures">
  <Text size="large" fontWeight="semi-bold">{$t('admin.job_failures')}</Text>
  <Text size="small" color="muted" class="mb-3">
    {$t('admin.job_failures_description', { values: { attempts: failures.attempts } })}
  </Text>
  <Stack gap={4}>
    {#each failures.jobs as job (job.jobName)}
      <div class="flex flex-col gap-1" data-testid="job-failures-{job.jobName}">
        <div class="flex items-center justify-between gap-2">
          <Text fontWeight="bold">
            {$t('admin.job_failures_count', { values: { job: $t(titles[job.jobName]), count: job.count } })}
          </Text>
          <Button size="small" variant="ghost" onclick={() => onRetry(job.jobName)}>
            {$t('admin.job_failures_retry')}
          </Button>
        </div>
        {#each job.assets as asset (asset.assetId)}
          <Text size="small">
            <Link href="/photos/{asset.assetId}">{asset.originalFileName}</Link>
            · {formatAge(asset.failedAt)} · {asset.error ?? $t('admin.job_failures_stopped')}
          </Text>
        {/each}
        {#if job.count > job.assets.length}
          <Text size="small" color="muted">
            {$t('admin.job_failures_more', { values: { count: job.count - job.assets.length } })}
          </Text>
        {/if}
      </div>
    {/each}
  </Stack>
</section>
