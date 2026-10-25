<script lang="ts">
  import JobFailures from '$lib/components/admin/JobFailures.svelte';
  import MachineLearningModels from '$lib/components/admin/MachineLearningModels.svelte';
  import ResourceCheckReport from '$lib/components/admin/ResourceCheckReport.svelte';
  import AdminPageLayout from '$lib/components/layouts/AdminPageLayout.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import JobsPanel from './QueuePanel.svelte';
  import { queueManager } from '$lib/managers/queue-manager.svelte';
  import { getQueuesActions } from '$lib/services/queue.service';
  import { getJobFailures, getMachineLearningModels, type QueueResponseDto } from '@immich/sdk';
  import { CommandPaletteDefaultProvider, Container, type ActionItem } from '@immich/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  type Props = {
    data: PageData;
  };

  const { data }: Props = $props();

  onMount(() => queueManager.listen());

  // the progress of making the results of a model again, which takes hours for a large library
  let models = $state(data.models);
  // the files that jobs failed on again and again
  let failures = $state(data.failures);
  const refresh = async () => {
    models = await getMachineLearningModels().catch(() => models);
    failures = await getJobFailures().catch(() => failures);
  };
  onMount(() => {
    const interval = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(interval);
  });

  let queues = $derived<QueueResponseDto[]>(queueManager.queues);

  const { ResumePaused, CreateJob, ManageConcurrency } = $derived(getQueuesActions($t, queueManager.queues));
  const commands: ActionItem[] = $derived([CreateJob, ManageConcurrency]);

  const onQueueUpdate = (update: QueueResponseDto) => {
    queues = queues.map((queue) => {
      if (queue.name === update.name) {
        return update;
      }
      return queue;
    });
  };
</script>

<CommandPaletteDefaultProvider name={$t('admin.queues')} actions={commands} />

<OnEvents {onQueueUpdate} />

<AdminPageLayout breadcrumbs={[{ title: data.meta.title }]} actions={[ResumePaused, CreateJob, ManageConcurrency]}>
  <Container size="medium" center>
    {#if models.tasks.some(({ enabled }) => enabled)}
      <div class="mb-8">
        <MachineLearningModels tasks={models.tasks} backoff={models.backoff} onChange={() => void refresh()} />
      </div>
    {/if}
    {#if data.resources}
      <div class="mb-8">
        <ResourceCheckReport check={data.resources} />
      </div>
    {/if}
    {#if failures.jobs.length > 0}
      <div class="mb-8">
        <JobFailures {failures} onChange={() => void refresh()} />
      </div>
    {/if}
    {#if queues}
      <JobsPanel {queues} />
    {/if}
  </Container>
</AdminPageLayout>
