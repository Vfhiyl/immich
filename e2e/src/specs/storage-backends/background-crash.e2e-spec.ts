import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { Api, ImmichServer, TestEnvironment } from 'src/storage-backends.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// the background work runs in a process of its own: when it dies (as when memory runs out), the api goes on
describe('a crash of the background work', () => {
  let environment: TestEnvironment;
  let server: ImmichServer;
  let api: Api;

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

  it('should leave the api up, and start the background work again', async () => {
    const background = await server.workerPid('microservices');
    const apiPid = await server.workerPid('api');
    expect(background).toBeDefined();
    expect(apiPid).toBeDefined();
    // the kernel kills the background work first when memory runs out
    await expect(readFile(`/proc/${background}/oom_score_adj`, 'utf8')).resolves.toBe('500\n');
    await expect(readFile(`/proc/${apiPid}/oom_score_adj`, 'utf8')).resolves.toBe('0\n');

    process.kill(background!, 'SIGKILL');
    await sleep(200);
    const { status } = await api.json('/users/me');
    expect(status).toBe(200);

    let restarted: number | undefined;
    for (let attempt = 0; attempt < 150 && !restarted; attempt++) {
      await sleep(200);
      const pid = await server.workerPid('microservices');
      restarted = pid === background ? undefined : pid;
    }
    expect(restarted).toBeDefined();
    expect(await server.workerPid('api')).toBe(apiPid);
    expect(server.logs).toContain('microservices worker exited with SIGKILL, starting it again in 1s');

    // killed as the kernel kills it when memory runs out: the admin is told on the jobs page, and notified
    let kills = 0;
    for (let attempt = 0; attempt < 100 && kills === 0; attempt++) {
      await sleep(200);
      const { body } = await api.json<{ memoryKills: { lastWeek: number } }>('/admin/resources');
      kills = body.memoryKills.lastWeek;
    }
    expect(kills).toBe(1);
    const { body: notifications } = await api.json<Array<{ title: string }>>('/notifications');
    expect(notifications.map(({ title }) => title)).toContain('The server ran out of memory');
  });
});
