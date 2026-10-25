import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Api, ImmichServer, TestEnvironment, eventually, testAssetDir } from 'src/storage-backends.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const photoPath = join(testAssetDir, 'formats/jpg/el_torcal_rocks.jpg');

/** JOB_WINDOW of the server: how many jobs a queue keeps waiting in redis */
const window = 200;

type Queue = { statistics: { waiting: number; paused: number } };

// a queue keeps a window of its jobs in redis, and the rest in the database, until it runs low
describe('the window of a queue', () => {
  let environment: TestEnvironment;
  let server: ImmichServer;
  let api: Api;

  const backlog = async () => {
    const [{ count }] = await environment.query<{ count: number }>(
      `select count(*)::int as count from job_backlog where "queueName" = 'thumbnailGeneration'`,
    );
    return count;
  };
  const command = (command: string) =>
    api.json('/jobs/thumbnailGeneration', { method: 'PUT', body: { command, force: false } });

  beforeAll(async () => {
    environment = await TestEnvironment.create();
    server = await ImmichServer.start(environment, { backends: false });
    api = await Api.signUpAdmin();
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

  it('should keep the jobs beyond the window in the database, and run them all', async () => {
    await command('pause');
    const photo = await readFile(photoPath);
    const count = window + 30;
    for (let index = 0; index < count; index++) {
      // another file each time
      await api.upload(`/photo-${index}.jpg`, Buffer.concat([photo, Buffer.from(String(index))]));
    }

    // their thumbnails are queued once their metadata is read
    await eventually(async () => expect(await backlog()).toBe(count - window), { timeout: 120_000 });
    const { body: paused } = await api.json<Queue>('/queues/thumbnailGeneration');
    // those in redis wait as paused
    expect(paused.statistics).toMatchObject({ waiting: count - window, paused: window });

    await command('resume');
    await eventually(
      async () => {
        const [{ missing }] = await environment.query<{ missing: number }>(
          `select count(*)::int as missing from asset where thumbhash is null`,
        );
        expect(missing).toBe(0);
      },
      { timeout: 120_000 },
    );
    expect(await backlog()).toBe(0);
  }, 300_000);
});
