import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Api,
  eventually,
  ImmichServer,
  S3Service,
  testAssetDir,
  TestEnvironment,
  type LocalBackend,
} from 'src/storage-backends.js';

// The pages of storage backends, in a browser, against a real server with the built web app: encrypted originals and
// backups on an S3 service (whose requests are counted), derived files and a replica on local folders
const photoPath = join(testAssetDir, 'formats/jpg/el_torcal_rocks.jpg');
const pngPath = join(testAssetDir, 'formats/png/density_plot.png');
const webpPath = join(testAssetDir, 'formats/webp/denali.webp');

type Assets = { assets: { items: Array<{ id: string; originalFileName: string }> } };

/** The keys of a master key file, without its comments */
const keysOf = (text: string) => text.split('\n').filter((line) => line && !line.startsWith('#'));

/** A row of the table on the page that names the file */
const rowOf = (page: Page, text: string) => page.getByRole('row').filter({ hasText: text });

test.describe('storage pages', () => {
  test.describe.configure({ mode: 'serial' });

  let environment: TestEnvironment;
  let s3: S3Service;
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

  const findAssets = async (originalFileName: string) => {
    const { body } = await api.json<Assets>('/search/metadata', { method: 'POST', body: { originalFileName } });
    return body.assets.items;
  };

  test.beforeAll(async () => {
    environment = await TestEnvironment.create({ web: true, configFile: false });
    s3 = await S3Service.start(environment);
    const backends: LocalBackend[] = [
      { id: 'originals', role: 'originals', s3: { service: s3, prefix: 'originals/' } },
      { id: 'derived', role: 'derived' },
      { id: 'backups', role: 'backup', s3: { service: s3, prefix: 'backups/' } },
      { id: 'replica', role: 'replica', replicaOf: ['originals', 'backup'], encrypted: true },
    ];
    await environment.writeBackends(backends);
    server = await ImmichServer.start(environment);
    api = await Api.signUpAdmin();
    await api.configure();
  });

  test.afterAll(async () => {
    await server?.stop();
    s3?.stop();
    await environment?.destroy();
  });

  test.beforeEach(async ({ context }) => {
    await signIn(context);
  });

  test.afterEach(() => {
    const { status, expectedStatus, title } = test.info();
    if (status !== expectedStatus) {
      console.log(`Server output for "${title}":\n${server?.logs.split('\n').slice(-40).join('\n')}`);
    }
  });

  test('shows how storage is configured, without a way to change it', async ({ page }) => {
    await page.goto('/admin/storage');

    await expect(page.getByText('cannot be changed here')).toBeVisible();
    const configuration = page.getByRole('table').first();
    await expect(rowOf(page, 'originals').first()).toContainText('s3:');
    await expect(rowOf(page, 'originals').first()).toContainText('Yes');
    await expect(rowOf(page, 'derived').first()).toContainText('local:');
    await expect(rowOf(page, 'replica').first()).toContainText('replica (originals, backup)');
    await expect(configuration.locator('input, select, textarea')).toHaveCount(0);
    await expect(page.getByText(/Deleted originals are kept for 360 days/)).toBeVisible();
    await expect(page.getByText(/Master key [0-9a-f]+ has not been downloaded yet/)).toBeVisible();
  });

  test('downloads the master key after the password was confirmed, and stops warning', async ({ page }) => {
    await page.goto('/admin/storage');
    await expect(page.getByText(/Master key [0-9a-f]+ has not been downloaded yet/)).toBeVisible();

    await page.getByRole('button', { name: 'Download master key' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Confirm password').fill('wrong');
    await dialog.getByRole('button', { name: 'Download master key' }).click();
    await expect(page.getByText('Wrong password')).toBeVisible();

    await dialog.getByLabel('Confirm password').fill('admin');
    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Download master key' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^immich-master-keys-[0-9a-f]+\.txt$/);
    const downloaded = await readFile(await file.path(), 'utf8');
    expect(keysOf(downloaded)).toEqual(keysOf(await readFile(environment.masterKeyFile, 'utf8')));

    await expect(page.getByText(/Master key [0-9a-f]+ was last downloaded/)).toBeVisible();
    await page.reload();
    await expect(page.getByText(/Master key [0-9a-f]+ was last downloaded/)).toBeVisible();
    // every administrator is told
    const { body } = await api.json<Array<{ title: string }>>('/notifications');
    expect(body.map(({ title }) => title)).toContain('The master keys were downloaded');
  });

  test('asks to save the master key while the server is set up', async ({ page }) => {
    await page.goto('/auth/onboarding?step=master_key');
    await expect(page.getByText('Download a copy of the master key now')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download master key' })).toBeVisible();
  });

  test('uploads a large photo in parts, going on when the connection breaks', async ({ page }) => {
    const content = Buffer.concat([await readFile(photoPath), randomBytes(40 * 1024 * 1024)]);
    const file = join(environment.root, 'browser-upload.jpg');
    await writeFile(file, content);

    // the first part that is appended is cut off: the upload asks the server where it stands, and goes on
    let appends = 0;
    let cutOff = 0;
    await page.route('**/api/upload/*', async (route) => {
      if (route.request().method() === 'PATCH' && appends++ === 0) {
        cutOff++;
        await route.abort('connectionreset');
        return;
      }
      await route.continue();
    });

    await page.goto('/photos');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Upload', exact: true }).first().click();
    const fileChooser = await chooser;
    await fileChooser.setFiles(file);

    const [asset] = await eventually(
      async () => {
        const assets = await findAssets('browser-upload.jpg');
        expect(assets).toHaveLength(1);
        return assets;
      },
      { timeout: 90_000 },
    );
    expect(cutOff).toBe(1);
    expect(appends).toBeGreaterThan(1);
    const { status, body } = await api.download(`/assets/${asset.id}/original`);
    expect(status).toBe(200);
    expect(body.equals(content)).toBe(true);
  });

  test('runs a check of the stored files, and shows when it ran', async ({ page }) => {
    await page.goto('/admin/storage');
    await expect(page.getByText('Last comparison with storage: never')).toBeVisible();

    await page.getByRole('button', { name: 'Compare with storage' }).click();
    await expect(page.getByText('The check was started')).toBeVisible();

    await expect(async () => {
      await page.reload();
      await expect(page.getByText(/Last comparison with storage: (?!never)/)).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 60_000 });
    await expect(page.getByText('No problems with stored files')).toBeVisible();

    await page.getByRole('link', { name: 'Reports' }).click();
    await expect(page).toHaveURL(/\/admin\/storage\/issues/);
    await expect(page.getByRole('row').filter({ hasText: 'reconcile' }).first()).toBeVisible();
  });

  test('imports a deleted original as a new photo, and deletes another from storage with the password', async ({
    page,
  }) => {
    const { id: pngId } = await api.upload(pngPath, await readFile(pngPath));
    const { id: webpId } = await api.upload(webpPath, await readFile(webpPath));
    await api.deleteAssets([pngId, webpId]);

    await page.goto('/admin/storage/deleted');
    await expect(rowOf(page, 'density_plot.png')).toBeVisible();
    await expect(rowOf(page, 'denali.webp')).toBeVisible();

    await rowOf(page, 'density_plot.png').getByRole('button', { name: 'Import as new photo' }).click();
    await expect(page.getByText('The original was imported as a new photo')).toBeVisible();
    const [imported] = await findAssets('density_plot.png');
    expect(imported.id).not.toBe(pngId);
    // it stays until its deletion delay has passed, as the server keeps it; importing it again finds the photo
    await page.reload();
    await rowOf(page, 'density_plot.png').getByRole('button', { name: 'Import as new photo' }).click();
    await expect(page.getByText('The original was imported as a new photo')).toBeVisible();
    await expect(findAssets('density_plot.png')).resolves.toEqual([expect.objectContaining({ id: imported.id })]);

    await rowOf(page, 'denali.webp').getByRole('button', { name: 'Delete from storage' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('cannot be undone');
    const confirm = dialog.getByRole('button', { name: 'Delete from storage' });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel('Confirm password').fill('wrong');
    await confirm.click();
    await expect(page.getByText('Wrong password')).toBeVisible();
    await expect(rowOf(page, 'denali.webp')).toBeVisible();

    await dialog.getByLabel('Confirm password').fill('admin');
    await confirm.click();
    await expect(page.getByText('The original was deleted from storage')).toBeVisible();
    await expect(rowOf(page, 'denali.webp')).toHaveCount(0);
    await page.reload();
    await expect(rowOf(page, 'density_plot.png')).toBeVisible();
    await expect(rowOf(page, 'denali.webp')).toHaveCount(0);
  });

  test('estimates the costs by the prices filled in the settings', async ({ page }) => {
    await page.goto('/admin/system-settings?isOpen=storage-pricing');
    await page.getByRole('switch', { name: 'Prices for originals' }).click();
    await page.getByLabel('Currency').fill('CNY');
    await page.getByLabel('Storing 1 GiB for a month').fill('0.1');
    await page.getByLabel('10,000 write and list requests (PUT, POST, LIST)').fill('100');
    await page.getByLabel('10,000 read requests (GET, HEAD)').fill('10');
    await page.getByLabel('10,000 delete requests').fill('0');
    await page.getByLabel('Reading 1 GiB from the provider').fill('0.5');
    await page.getByLabel('Monthly budget').fill('1000');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Settings saved')).toBeVisible();

    // counted requests are written to the database every few seconds
    await expect(async () => {
      await page.goto('/admin/storage/usage');
      await expect(page.getByText(/Estimated cost: \d+\.\d\d CNY/)).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 60_000 });
    await expect(page.getByText(/of a budget of 1000\.00 CNY/)).toBeVisible();
    await expect(rowOf(page, 'api').first()).toBeVisible();
    await expect(page.locator('canvas').first()).toBeVisible();
  });

  test('exports the originals to the folder of the server', async ({ page }) => {
    await page.goto('/admin/storage');
    await expect(page.getByText(`Exported to ${environment.exportLocation}`)).toBeVisible();

    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(page.getByText('The export was started')).toBeVisible();
    await expect(page.getByText(/Export done: \d+ exported, 0 already exported, 0 failed/)).toBeVisible({
      timeout: 60_000,
    });
  });
});
