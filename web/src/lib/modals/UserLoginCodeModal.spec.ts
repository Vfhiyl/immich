import { createUserLoginCodeAdmin, type UserAdminResponseDto } from '@immich/sdk';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import UserLoginCodeModal from './UserLoginCodeModal.svelte';

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  createUserLoginCodeAdmin: vi.fn(),
}));

describe('UserLoginCodeModal component', () => {
  const user = { id: 'user-1', name: 'Ann' } as UserAdminResponseDto;
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  beforeEach(() => {
    vi.resetAllMocks();
  });

  test('shows the key of the server in self-signed mode, as the app shows it', async () => {
    const pin = btoa(String.fromCodePoint(...Array.from({ length: 32 }, (_, index) => index)));
    vi.mocked(createUserLoginCodeAdmin).mockResolvedValue({
      url: 'immich://login?server=https%3A%2F%2F203.0.113.7%3A2283&code=c&pin=p',
      server: 'https://203.0.113.7:2283',
      pin,
      expiresAt,
    });
    await render(UserLoginCodeModal, { props: { user, onClose: vi.fn() } });

    await expect.element(page.getByText('admin.user_login_code_key')).toBeVisible();
    await expect.element(page.getByTestId('login-code-key')).toBeVisible();
    // in a grid of 4 × 4
    const groups = [...page.getByTestId('login-code-key').element().querySelectorAll('span')].map(
      (group) => group.textContent,
    );
    expect(groups).toEqual(
      '0001 0203 0405 0607 0809 0A0B 0C0D 0E0F 1011 1213 1415 1617 1819 1A1B 1C1D 1E1F'.split(' '),
    );
  });

  test('shows no key otherwise', async () => {
    vi.mocked(createUserLoginCodeAdmin).mockResolvedValue({
      url: 'immich://login?server=https%3A%2F%2Fphotos.example.com&code=c',
      server: 'https://photos.example.com',
      expiresAt,
    });
    await render(UserLoginCodeModal, { props: { user, onClose: vi.fn() } });

    await expect.element(page.getByTestId('login-code')).toBeVisible();
    expect(page.getByTestId('login-code-key').query()).toBeNull();
  });
});
