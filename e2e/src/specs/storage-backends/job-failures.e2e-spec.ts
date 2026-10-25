import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Api, ImmichServer, TestEnvironment, eventually } from 'src/storage-backends.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

type Failures = {
  attempts: number;
  jobs: Array<{
    jobName: string;
    count: number;
    assets: Array<{ assetId: string; originalFileName: string; attempts: number; error: string | null }>;
  }>;
};

// a file that a job fails on again and again: it fails in its queue, and after a few attempts the job is no longer
// queued for it, not even by the nightly tasks, until an admin retries it
describe('files that jobs fail on', () => {
  let environment: TestEnvironment;
  let server: ImmichServer;
  let api: Api;
  let assetId: string;

  const attempts = async () => {
    const rows = await environment.query<{ attempts: number }>(
      `select attempts from asset_job_failure where "assetId" = $1 and "jobName" = 'AssetGenerateThumbnails'`,
      [assetId],
    );
    return rows[0]?.attempts;
  };
  const queueMissingThumbnails = () =>
    api.json('/jobs/thumbnailGeneration', { method: 'PUT', body: { command: 'start', force: false } });

  beforeAll(async () => {
    environment = await TestEnvironment.create();
    server = await ImmichServer.start(environment, { backends: false });
    api = await Api.signUpAdmin();
    // a JPEG that ends after its first bytes
    const content = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(2048)]);
    ({ id: assetId } = await api.upload('/broken.jpg', content));
  }, 120_000);

  afterEach(({ task }) => {
    if (task.result?.state === 'fail') {
      console.log(`Server output for "${task.name}":\n${server?.logs.split('\n').slice(-60).join('\n')}`);
    }
  });

  afterAll(async () => {
    await server?.stop();
    await environment?.destroy();
  });

  it('should hold the job back after it failed a few times in a row, and queue it again on retry', async () => {
    await eventually(async () => expect(await attempts()).toBe(1));
    for (const attempt of [2, 3]) {
      await queueMissingThumbnails();
      await eventually(async () => expect(await attempts()).toBe(attempt));
    }

    const { body: failures } = await api.json<Failures>('/admin/job-failures');
    expect(failures.attempts).toBe(3);
    expect(failures.jobs).toEqual([
      {
        jobName: 'AssetGenerateThumbnails',
        count: 1,
        assets: [
          {
            assetId,
            originalFileName: 'broken.jpg',
            attempts: 3,
            error: expect.any(String),
            failedAt: expect.any(String),
          },
        ],
      },
    ]);
    // it failed in its queue too
    const { body: queue } = await api.json<{ statistics: { failed: number } }>('/queues/thumbnailGeneration');
    expect(queue.statistics.failed).toBeGreaterThanOrEqual(1);

    // no longer queued
    await queueMissingThumbnails();
    await sleep(3000);
    expect(await attempts()).toBe(3);

    const { body: retried } = await api.json<{ count: number }>('/admin/job-failures/retry', {
      method: 'POST',
      body: { jobName: 'AssetGenerateThumbnails' },
    });
    expect(retried).toEqual({ count: 1 });
    await eventually(async () => expect(await attempts()).toBe(1));
    const { body: after } = await api.json<Failures>('/admin/job-failures');
    expect(after.jobs).toEqual([]);
  });
});
