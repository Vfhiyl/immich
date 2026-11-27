import { TrackedJobName, retryJobFailures, type JobFailuresResponseDto } from '@immich/sdk';
import { describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
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
          ownerName: 'Ann',
          ownerEmail: 'ann@immich.cloud',
          attempts: 3,
          error: null,
          failedAt: new Date().toISOString(),
        },
        {
          assetId: 'asset-2',
          originalFileName: 'broken.heic',
          ownerName: 'Bob',
          ownerEmail: 'bob@immich.cloud',
          attempts: 4,
          error: 'Input file has corrupt header',
          failedAt: new Date().toISOString(),
        },
      ],
    },
  ],
};

describe('JobFailures component', () => {
  test('lists the files a job failed on, and why', async () => {
    await render(JobFailures, { failures });

    // the texts are keys in unit tests
    const thumbnails = page.getByTestId('job-failures-AssetGenerateThumbnails');
    await expect
      .element(thumbnails.getByRole('link', { name: 'panorama.tif' }))
      .toHaveAttribute('href', '/photos/asset-1');
    await expect.element(thumbnails.getByText(/admin.job_failures_stopped/)).toBeInTheDocument();
    await expect.element(thumbnails.getByText(/Input file has corrupt header/)).toBeInTheDocument();
    // whose file it is
    await expect.element(thumbnails.getByText(/admin.job_failure_owner/).first()).toBeInTheDocument();
    await expect.element(thumbnails.getByText('admin.job_failures_more')).toBeInTheDocument();
  });

  test('queues the job again for them', async () => {
    vi.mocked(retryJobFailures).mockResolvedValue({ count: 51 });
    const onChange = vi.fn();
    await render(JobFailures, { failures, onChange });

    await page.getByRole('button', { name: 'admin.job_failures_retry' }).click();

    expect(retryJobFailures).toHaveBeenCalledWith({
      jobFailureRetryDto: { jobName: TrackedJobName.AssetGenerateThumbnails },
    });
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
  });
});
