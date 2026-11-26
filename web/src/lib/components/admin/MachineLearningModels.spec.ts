import {
  MachineLearningBackoffLevel,
  type MachineLearningModelDto,
  type MachineLearningTaskModelsDto,
} from '@immich/sdk';
import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import MachineLearningModels from './MachineLearningModels.svelte';

const model = (name: string, fingerprint: string | null = 'a'.repeat(64)): MachineLearningModelDto => ({
  name,
  fingerprint,
  format: fingerprint ? 'onnx' : null,
  firstSeenAt: null,
  lastSeenAt: null,
});

const task = (overrides: Partial<MachineLearningTaskModelsDto>): MachineLearningTaskModelsDto => ({
  task: 'clip',
  enabled: true,
  configuredModel: 'ViT-B-32__openai',
  target: model('ViT-B-32__openai'),
  active: model('ViT-B-32__openai'),
  rebuild: null,
  replaced: null,
  conflict: null,
  regroup: null,
  ...overrides,
});

describe('MachineLearningModels component', () => {
  test('tells the model of each task, and nothing more while nothing changes', async () => {
    await render(MachineLearningModels, {
      tasks: [task({}), task({ task: 'ocr', enabled: false, active: null, target: model('PP-OCRv5_mobile', null) })],
    });

    // the texts are keys in unit tests
    const clip = page.getByTestId('ml-task-clip');
    await expect.element(clip.getByText(/ViT-B-32__openai/)).toBeInTheDocument();
    await expect.element(clip.getByText('admin.machine_learning_models_rebuilding')).not.toBeInTheDocument();
    await expect.element(clip.getByText('admin.machine_learning_models_searched')).not.toBeInTheDocument();
    await expect
      .element(page.getByTestId('ml-task-ocr').getByText('admin.machine_learning_models_disabled'))
      .toBeInTheDocument();
  });

  test('tells the progress of a rebuild, and which model searches use meanwhile', async () => {
    await render(MachineLearningModels, {
      tasks: [
        task({
          target: model('ViT-L-14__openai', null),
          active: model('ViT-B-32__openai'),
          rebuild: { startedAt: new Date().toISOString(), finishedAt: null, total: 10, done: 4 },
        }),
      ],
    });

    await expect.element(page.getByText('admin.machine_learning_models_rebuilding')).toBeInTheDocument();
    await expect.element(page.getByText('admin.machine_learning_models_searched')).toBeInTheDocument();
    await expect.element(page.getByText(/admin.machine_learning_models_files_unknown/)).toBeInTheDocument();
  });

  test('warns of files that changed, and of servers that answer with files that were replaced', async () => {
    const at = new Date().toISOString();
    await render(MachineLearningModels, {
      tasks: [
        task({
          task: 'facial-recognition',
          active: null,
          rebuild: { startedAt: at, finishedAt: at, total: null, done: null },
          replaced: { from: model('buffalo_l', 'b'.repeat(64)), to: model('buffalo_l'), at },
          conflict: { model: model('buffalo_l', 'b'.repeat(64)), at },
        }),
      ],
    });

    await expect.element(page.getByText('admin.machine_learning_models_rebuilt')).toBeInTheDocument();
    await expect.element(page.getByText('admin.machine_learning_models_replaced')).toBeInTheDocument();
    await expect.element(page.getByText('admin.machine_learning_models_conflict')).toBeInTheDocument();
  });

  test('tells when its jobs give way to the memory of machine learning', async () => {
    const memory = { used: 7 * 1024 ** 3, limit: 8 * 1024 ** 3, source: 'cgroup2' };
    const { rerender } = await render(MachineLearningModels, {
      tasks: [task({})],
      backoff: { level: MachineLearningBackoffLevel.Normal, checkedAt: '', memory, pressure: null },
    });
    await expect.element(page.getByText('admin.machine_learning_backoff_memory')).toBeInTheDocument();

    await rerender({
      tasks: [task({})],
      backoff: { level: MachineLearningBackoffLevel.Paused, checkedAt: '', memory, pressure: null },
    });
    await expect.element(page.getByText('admin.machine_learning_backoff_paused')).toBeInTheDocument();
  });

  test('tells what the regroup of people changed, with the named people, and offers to undo it', async () => {
    const at = new Date().toISOString();
    await render(MachineLearningModels, {
      tasks: [
        task({
          task: 'facial-recognition',
          active: null,
          regroup: {
            startedAt: at,
            finishedAt: at,
            undoneAt: null,
            facesLeft: 12,
            facesJoined: 30,
            people: [{ personGroupId: 'mom', names: 'Mom', before: 500, left: 12, joined: 3 }],
            otherPeople: 4,
          },
        }),
      ],
    });

    const regroup = page.getByTestId('ml-regroup');
    await expect.element(regroup.getByText('admin.machine_learning_models_regroup_done')).toBeInTheDocument();
    await expect.element(regroup.getByText('admin.machine_learning_models_regroup_changes')).toBeInTheDocument();
    await expect
      .element(regroup.getByRole('button', { name: 'admin.machine_learning_models_regroup_undo' }))
      .toBeInTheDocument();
  });

  test('tells a regroup that runs, or was undone, without offering to undo it', async () => {
    const at = new Date().toISOString();
    const regroup = { startedAt: at, facesLeft: 0, facesJoined: 0, people: [], otherPeople: 0 };
    const { rerender } = await render(MachineLearningModels, {
      tasks: [task({ task: 'facial-recognition', regroup: { ...regroup, finishedAt: null, undoneAt: null } })],
    });
    await expect.element(page.getByText('admin.machine_learning_models_regroup_running')).toBeInTheDocument();

    await rerender({
      tasks: [task({ task: 'facial-recognition', regroup: { ...regroup, finishedAt: at, undoneAt: at } })],
    });
    await expect.element(page.getByText('admin.machine_learning_models_regroup_undone')).toBeInTheDocument();
    await expect
      .element(page.getByRole('button', { name: 'admin.machine_learning_models_regroup_undo' }))
      .not.toBeInTheDocument();
  });
});
