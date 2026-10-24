import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Api,
  eventually,
  ImmichServer,
  testAssetDir,
  TestEnvironment,
  type LocalBackend,
} from 'src/storage-backends.js';

// A new server in a browser: what it tells about a storage configuration that does not work, and the recovery of a
// lost server from its storage and master key alone, with encrypted originals and database backups
const photoPath = join(testAssetDir, 'formats/jpg/el_torcal_rocks.jpg');
const backends: LocalBackend[] = [
  { id: 'originals', role: 'originals', encrypted: true },
  { id: 'derived', role: 'derived' },
  { id: 'backups', role: 'backup', encrypted: true },
];

test.describe('setup and recovery', () => {
  test.describe.configure({ mode: 'serial' });

  let environment: TestEnvironment;
  let server: ImmichServer | undefined;

  test.beforeEach(async () => {
    environment = await TestEnvironment.create({ web: true, configFile: false });
    await environment.writeBackends(backends);
  });

  test.afterEach(async () => {
    const { status, expectedStatus, title } = test.info();
    if (status !== expectedStatus) {
      console.log(`Server output for "${title}":\n${server?.logs.split('\n').slice(-60).join('\n')}`);
    }
    await server?.stop();
    server = undefined;
    await environment?.destroy();
  });

  test('tells what is wrong with the storage of a new server, and starts once it is fixed', async ({ page }) => {
    const keyFile = await readFile(environment.masterKeyFile, 'utf8');
    await rm(environment.masterKeyFile);
    server = await ImmichServer.start(environment, { maintenance: true });

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'The storage needs attention' })).toBeVisible();
    await expect(page.getByText(`The master key file ${environment.masterKeyFile} does not exist`)).toBeVisible();
    await expect(page.getByText(/Put the master key file at this path/)).toBeVisible();
    await expect(page.getByText(/derived \(derived, local\): works/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();

    // the deployer puts the key file in place
    await writeFile(environment.masterKeyFile, keyFile);
    await page.getByRole('button', { name: 'Check again' }).click();
    await expect(page.getByText('The storage configuration works.')).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('heading', { name: 'Welcome to Immich' })).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText('The storage configuration works.')).toBeVisible();
    await expect(page.getByText(/originals \(originals, local\): works/)).toBeVisible();
    // what the server has to run on
    await expect(page.getByText('Resources', { exact: true })).toBeVisible();
    await expect(page.getByText(/^Free disk in /)).toBeVisible();
  });

  test('restores a lost server from the database backups in its storage', async ({ page }) => {
    test.setTimeout(240_000);
    server = await ImmichServer.start(environment);
    let api = await Api.signUpAdmin();
    await api.configure();
    const photo = Buffer.concat([await readFile(photoPath), randomBytes(100)]);
    const { id } = await api.upload(photoPath, photo);
    await api.json('/jobs', { method: 'POST', body: { name: 'backup-database' } });
    await eventually(
      async () => {
        const { body } = await api.json<{ backups: unknown[] }>('/admin/storage/database-backups');
        expect(body.backups).toHaveLength(1);
      },
      { timeout: 60_000 },
    );
    await server.stop();

    // a new server with the same configuration, master key and storage, but nothing else
    await environment.loseServer();
    server = await ImmichServer.start(environment);

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Welcome to Immich' })).toBeVisible();
    await expect(
      page.getByText(/The storage holds 1 database backup of a server, the latest immich-db-backup-/),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Restore from backup' }).click();

    // the folders of the media location are empty: the photos are in storage
    await expect(page.getByText('The storage configuration works.')).toBeVisible({ timeout: 90_000 });
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('Database backups in storage')).toBeVisible();
    await page.getByRole('button', { name: 'Restore', exact: true }).first().click();
    await page.getByRole('dialog').getByRole('button', { name: 'Restore' }).click();

    // restored, the server starts with the database of the lost one
    await expect(page).toHaveURL(/\/auth\/login/, { timeout: 180_000 });
    api = await Api.login({ email: 'admin@immich.cloud', password: 'admin' });
    const { status, body } = await api.download(`/assets/${id}/original`);
    expect(status).toBe(200);
    expect(body.equals(photo)).toBe(true);
  });
});
