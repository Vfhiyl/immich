import { retryJobFailures, TrackedJobName, type JobFailuresResponseDto } from '@immich/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getAnimateMock } from '$lib/__mocks__/animate.mock';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import { getVisualViewportMock } from '$lib/__mocks__/visual-viewport.mock';
import JobFailures from './JobFailures.svelte';

vi.mock('@immich/sdk', async (original) => ({
  ...(await original<typeof import('@immich/sdk')>()),
  retryJobFailures: vi.fn(),
}));

const failures: JobFailuresResponseDto = {
  attempts: 3,
  jobs: [
    {
      jobName: TrackedJobName.AssetGenerateThumbnails,
      count: 51,
      assets: [
        {
          assetId: 'asset-1',
          originalFileName: 'panorama.tif',
          attempts: 3,
          error: null,
          failedAt: new Date().toISOString(),
        },
        {
          assetId: 'asset-2',
          originalFileName: 'broken.heic',
          attempts: 4,
          error: 'Input file has corrupt header',
          failedAt: new Date().toISOString(),
        },
      ],
    },
  ],
};

describe('JobFailures component', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
    vi.stubGlobal('visualViewport', getVisualViewportMock());
    Element.prototype.animate = getAnimateMock();
  });

  test('lists the files a job failed on, and why', () => {
    render(JobFailures, { failures });

    // the texts are keys in unit tests
    const thumbnails = screen.getByTestId('job-failures-AssetGenerateThumbnails');
    expect(within(thumbnails).getByRole('link', { name: 'panorama.tif' })).toHaveAttribute('href', '/photos/asset-1');
    expect(within(thumbnails).getByText(/admin.job_failures_stopped/)).toBeInTheDocument();
    expect(within(thumbnails).getByText(/Input file has corrupt header/)).toBeInTheDocument();
    expect(within(thumbnails).getByText('admin.job_failures_more')).toBeInTheDocument();
  });

  test('queues the job again for them', async () => {
    vi.mocked(retryJobFailures).mockResolvedValue({ count: 51 });
    const onChange = vi.fn();
    render(JobFailures, { failures, onChange });

    await fireEvent.click(screen.getByRole('button', { name: 'admin.job_failures_retry' }));

    expect(retryJobFailures).toHaveBeenCalledWith({
      jobFailureRetryDto: { jobName: TrackedJobName.AssetGenerateThumbnails },
    });
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
  });
});
