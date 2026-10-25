import { expect, test, type BrowserContext } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Api, ImmichServer, testAssetDir, TestEnvironment } from 'src/storage-backends.js';

// telling facial recognition that photos of a person are not this person, in a browser
const photoPath = join(testAssetDir, 'metadata/faces/portrait.jpg');

test.describe('people', () => {
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

  test('takes selected photos from a person for good', async ({ context, page }) => {
    await signIn(context);
    const { body: person } = await api.json<{ id: string }>('/people', { method: 'POST', body: { name: 'Grandma' } });
    const photos: string[] = [];
    for (const extra of ['one', 'two']) {
      const { id } = await api.upload(photoPath, Buffer.concat([await readFile(photoPath), Buffer.from(extra)]));
      await api.json('/faces', {
        method: 'POST',
        body: {
          assetId: id,
          personId: person.id,
          imageWidth: 100,
          imageHeight: 100,
          x: 10,
          y: 10,
          width: 20,
          height: 20,
        },
      });
      photos.push(id);
    }

    await page.goto(`/people/${person.id}`);
    const wrong = page.locator(`[data-asset="${photos[0]}"]`);
    await expect(wrong).toBeVisible();
    await wrong.focus();
    await page.keyboard.press('x');
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('menuitem', { name: 'Not this person' }).click();
    await expect(page.getByText(/Remove 1 photo from Grandma\?/)).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();

    await expect(page.getByText('1 photo will no longer be suggested for Grandma')).toBeVisible();
    await expect(wrong).toBeHidden();
    await expect(page.locator(`[data-asset="${photos[1]}"]`)).toBeVisible();
    const rejected = await environment.query<{ assetId: string }>(
      `select f."assetId" from face_user_rejection r join asset_face f on f.id = r."faceId" where r."personGroupId" = $1`,
      [person.id],
    );
    expect(rejected).toEqual([{ assetId: photos[0] }]);
  });
});
