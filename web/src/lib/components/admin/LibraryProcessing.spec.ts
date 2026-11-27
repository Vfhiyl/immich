import { ProcessingStep, QueueName, type QueueResponseDto } from '@immich/sdk';
import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import LibraryProcessing from './LibraryProcessing.svelte';

const step = (step: ProcessingStep, total: number, done: number, perHour: number, enabled = true) => ({
  step,
  enabled,
  total,
  done,
  perHour,
});

const queue = (name: QueueName, waiting: number, isPaused = false) =>
  ({
    name,
    isPaused,
    statistics: { active: 0, completed: 0, delayed: 0, failed: 0, paused: 0, waiting },
  }) as QueueResponseDto;

describe('LibraryProcessing component', () => {
  test('shows each step: what is done, what is left, how fast and how long at that pace', async () => {
    await render(LibraryProcessing, {
      props: {
        steps: [
          step(ProcessingStep.Metadata, 1000, 1000, 0),
          step(ProcessingStep.SmartSearch, 1000, 400, 300),
          step(ProcessingStep.Faces, 1000, 980, 1200),
          step(ProcessingStep.Ocr, 1000, 300, 0),
          step(ProcessingStep.Duplicates, 400, 0, 0, false),
        ],
      },
    });

    await expect.element(page.getByTestId('processing-metadata')).toBeInTheDocument();
    const text = (step: string) => page.getByTestId(`processing-${step}`).element().textContent;

    expect(text('metadata')).toMatch(/admin\.processing_step_metadata.*\(100%\).*admin\.processing_complete/s);
    // 600 left at 300 per hour: about 2 hours
    expect(text('smart-search')).toMatch(
      /\(40%\).*admin\.processing_left.*admin\.processing_rate.*admin\.processing_eta_hours/s,
    );
    // 20 left at 1200 per hour: about a minute
    expect(text('faces')).toMatch(/admin\.processing_eta_minutes/s);
    // left, but none done lately, and nothing in its queue
    expect(text('ocr')).toMatch(/admin\.processing_not_queued/s);
    expect(text('duplicates')).toMatch(/admin\.processing_disabled/s);
    expect(text('duplicates')).not.toMatch(/%/s);
  });

  test('tells why a step does not move: nothing queued, a paused queue, or jobs that do not get done', async () => {
    await render(LibraryProcessing, {
      props: {
        steps: [
          step(ProcessingStep.SmartSearch, 100, 40, 0),
          step(ProcessingStep.Faces, 100, 40, 0),
          step(ProcessingStep.Ocr, 100, 40, 0),
        ],
        queues: [queue(QueueName.SmartSearch, 0), queue(QueueName.FaceDetection, 60, true), queue(QueueName.Ocr, 60)],
      },
    });

    await expect.element(page.getByTestId('processing-smart-search')).toBeInTheDocument();
    const text = (step: string) => page.getByTestId(`processing-${step}`).element().textContent;
    expect(text('smart-search')).toMatch(/admin\.processing_not_queued/s);
    expect(text('faces')).toMatch(/admin\.processing_paused/s);
    expect(text('ocr')).toMatch(/admin\.processing_queued.*admin\.processing_stalled/s);
  });
});
