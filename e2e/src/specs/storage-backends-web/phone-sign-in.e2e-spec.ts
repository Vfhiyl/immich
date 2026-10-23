import { expect, test, type BrowserContext } from '@playwright/test';
import { Api, baseUrl, ImmichServer, serverPort, TestEnvironment } from 'src/storage-backends.js';

// Signing a phone in with a QR code an administrator shows: a one-time code for the external domain, which the app
// exchanges for a session that administrators can end
/** What the mobile app does with the code of a QR code */
const loginWithCode = (code: string) =>
  fetch(`${baseUrl}/auth/login-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Immich_Android_3.3.5' },
    body: JSON.stringify({ code }),
  });

/** Whether a session token still signs in */
const statusOf = async (accessToken: string) => {
  const response = await fetch(`${baseUrl}/users/me`, { headers: { Authorization: `Bearer ${accessToken}` } });
  return response.status;
};

test.describe('phone sign-in', () => {
  test.describe.configure({ mode: 'serial' });

  let environment: TestEnvironment;
  let server: ImmichServer;
  let api: Api;
  let userId: string;

  const signIn = (context: BrowserContext) => {
    const cookie = { domain: 'localhost', path: '/', expires: 2_058_028_213, secure: false, sameSite: 'Lax' as const };
    return context.addCookies([
      { ...cookie, name: 'immich_access_token', value: api.token, httpOnly: true },
      { ...cookie, name: 'immich_auth_type', value: 'password', httpOnly: true },
      { ...cookie, name: 'immich_is_authenticated', value: 'true', httpOnly: false },
    ]);
  };

  test.beforeAll(async () => {
    environment = await TestEnvironment.create({ web: true, configFile: false });
    server = await ImmichServer.start(environment, { backends: false });
    api = await Api.signUpAdmin();
    await api.configure();
    const { body } = await api.json<{ id: string }>('/admin/users', {
      method: 'POST',
      body: { email: 'ann@immich.cloud', password: 'a password nobody types on a phone', name: 'Ann' },
    });
    userId = body.id;
  });

  test.afterAll(async () => {
    await server?.stop();
    await environment?.destroy();
  });

  test.beforeEach(async ({ context }) => {
    await signIn(context);
  });

  test('asks for the external domain first, which phones sign in to', async ({ page }) => {
    await page.goto(`/admin/users/${userId}`);
    await page.getByRole('button', { name: 'Sign in a phone' }).click();

    await expect(page.getByText(/Set the external domain in the server settings first/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open the server settings' })).toHaveAttribute(
      'href',
      /\/admin\/system-settings\?isOpen=server/,
    );
  });

  test('signs a phone in once with the code of the QR code, and signs it out from the list of devices', async ({
    page,
  }) => {
    const domain = `http://localhost:${serverPort}`;
    const { body: config } = await api.json<{ server: object }>('/system-config');
    await api.json('/system-config', {
      method: 'PUT',
      body: { ...config, server: { ...config.server, externalDomain: domain } },
    });

    await page.goto(`/admin/users/${userId}`);
    await page.getByRole('button', { name: 'Sign in a phone' }).click();
    const qrCode = page.getByTestId('login-code');
    await expect(qrCode.getByRole('img')).toBeVisible();
    await expect(page.getByText(`Signs in to ${domain}, valid until`)).toBeVisible();

    const link = new URL((await qrCode.getAttribute('data-value'))!);
    expect(link.protocol).toBe('immich:');
    expect(link.searchParams.get('server')).toBe(domain);
    const code = link.searchParams.get('code')!;

    const response = await loginWithCode(code);
    expect(response.status).toBe(201);
    const { accessToken, userEmail } = (await response.json()) as { accessToken: string; userEmail: string };
    expect(userEmail).toBe('ann@immich.cloud');
    await expect(statusOf(accessToken)).resolves.toBe(200);
    // once only
    await expect(loginWithCode(code)).resolves.toMatchObject({ status: 401 });

    // the phone is among the devices of the user, and an administrator signs it out
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(page.getByRole('button', { name: 'Log out' })).toHaveCount(1);
    await page.getByRole('button', { name: 'Log out' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByText('The device was signed out')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Log out' })).toHaveCount(0);
    await expect.poll(() => statusOf(accessToken)).toBe(401);
  });
});
