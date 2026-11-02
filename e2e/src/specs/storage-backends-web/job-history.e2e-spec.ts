import { expect, test, type BrowserContext } from '@playwright/test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Api, ImmichServer, TestEnvironment } from 'src/storage-backends.js';

// the history of jobs: a job that fails shows on the page, with its kind and reason, by time range
test.describe('job history', () => {
  test.describe.configure({ mode: 'serial' });

  let environment: TestEnvironment;
  let server: ImmichServer;
  let api: Api;

  const signIn = (context: BrowserContext) => {
    const cookie = { domain: 'localhost', path: '/', expires: 2_058_028_213, secure: false, sameSite: 'Lax' as const };
    return context.addCookies([
      { ...cookie, name: 'immich_access_token', value: api.token, httpOnly: true },
      { ...cookie, name: 'immich_auth_type', value: 'password', httpOnly: true },
      { ...cookie, name: 'immich_is_authenticated', value: 'true', httpOnly: false },
    ]);
  };

  test.beforeAll(async () => {
    environment = await TestEnvironment.create({ web: true });
    server = await ImmichServer.start(environment, { backends: false });
    api = await Api.signUpAdmin();
  });

  test.afterAll(async () => {
    await server?.stop();
    await environment?.destroy();
  });

  test.afterEach(() => {
    const { status, expectedStatus, title } = test.info();
    if (status !== expectedStatus) {
      console.log(`Server output for "${title}":\n${server?.logs.split('\n').slice(-40).join('\n')}`);
    }
  });

  test('shows a job that failed, why, and the share that failed', async ({ context, page }) => {
    await signIn(context);
    // a JPEG that is not one: its thumbnails cannot be made
    await api.upload('/broken.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]));

    let failed = 0;
    for (let attempt = 0; attempt < 100 && failed === 0; attempt++) {
      await sleep(300);
      const { body } = await api.json<{ totals: { failed: number } }>('/admin/job-history');
      failed = body.totals.failed;
    }
    expect(failed).toBeGreaterThan(0);

    await page.goto('/admin/job-history?range=today');
    await expect(page.getByTestId('job-history-totals')).toContainText('failed');
    await expect(page.getByText('AssetGenerateThumbnails').first()).toBeVisible();
    await expect(page.getByTestId('job-history-failure').first()).toContainText('broken.jpg');

    // by its reason
    await page
      .getByRole('link', { name: /immich-thumbnail exited with/ })
      .first()
      .click();
    await expect(page).toHaveURL(/reason=/);
    await expect(page.getByTestId('job-history-failure').first()).toContainText('AssetGenerateThumbnails');

    // the jobs page links to the history
    await page.goto('/admin/queues');
    await page.getByRole('button', { name: 'Job history' }).click();
    await expect(page).toHaveURL(/\/admin\/job-history/);
  });
});
