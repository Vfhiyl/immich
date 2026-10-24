import {
  MachineLearningBackoffLevel,
  type MachineLearningModelDto,
  type MachineLearningTaskModelsDto,
} from '@immich/sdk';
import { render, screen, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getAnimateMock } from '$lib/__mocks__/animate.mock';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import { getVisualViewportMock } from '$lib/__mocks__/visual-viewport.mock';
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
  ...overrides,
});

describe('MachineLearningModels component', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
    vi.stubGlobal('visualViewport', getVisualViewportMock());
    Element.prototype.animate = getAnimateMock();
  });

  test('tells the model of each task, and nothing more while nothing changes', () => {
    render(MachineLearningModels, {
      tasks: [task({}), task({ task: 'ocr', enabled: false, active: null, target: model('PP-OCRv5_mobile', null) })],
    });

    // the texts are keys in unit tests
    const clip = screen.getByTestId('ml-task-clip');
    expect(within(clip).getByText(/ViT-B-32__openai/)).toBeInTheDocument();
    expect(within(clip).queryByText('admin.machine_learning_models_rebuilding')).not.toBeInTheDocument();
    expect(within(clip).queryByText('admin.machine_learning_models_searched')).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId('ml-task-ocr')).getByText('admin.machine_learning_models_disabled'),
    ).toBeInTheDocument();
  });

  test('tells the progress of a rebuild, and which model searches use meanwhile', () => {
    render(MachineLearningModels, {
      tasks: [
        task({
          target: model('ViT-L-14__openai', null),
          active: model('ViT-B-32__openai'),
          rebuild: { startedAt: new Date().toISOString(), finishedAt: null, total: 10, done: 4 },
        }),
      ],
    });

    expect(screen.getByText('admin.machine_learning_models_rebuilding')).toBeInTheDocument();
    expect(screen.getByText('admin.machine_learning_models_searched')).toBeInTheDocument();
    expect(screen.getByText(/admin.machine_learning_models_files_unknown/)).toBeInTheDocument();
  });

  test('warns of files that changed, and of servers that answer with files that were replaced', () => {
    const at = new Date().toISOString();
    render(MachineLearningModels, {
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

    expect(screen.getByText('admin.machine_learning_models_rebuilt')).toBeInTheDocument();
    expect(screen.getByText('admin.machine_learning_models_replaced')).toBeInTheDocument();
    expect(screen.getByText('admin.machine_learning_models_conflict')).toBeInTheDocument();
  });

  test('tells when its jobs give way to the memory of machine learning', async () => {
    const memory = { used: 7 * 1024 ** 3, limit: 8 * 1024 ** 3, source: 'cgroup2' };
    const { rerender } = render(MachineLearningModels, {
      tasks: [task({})],
      backoff: { level: MachineLearningBackoffLevel.Normal, checkedAt: '', memory, pressure: null },
    });
    expect(screen.getByText('admin.machine_learning_backoff_memory')).toBeInTheDocument();

    await rerender({
      tasks: [task({})],
      backoff: { level: MachineLearningBackoffLevel.Paused, checkedAt: '', memory, pressure: null },
    });
    expect(screen.getByText('admin.machine_learning_backoff_paused')).toBeInTheDocument();
  });
});
