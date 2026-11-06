import { describe, it, expect, vi } from 'vitest';
import { TokenScope } from '@civitai/auth/token-scope';

/** The consent screen never renders a client_credentials-only scope for a user to approve. */

vi.mock('$lib/server/db/db', () => ({
  db: {
    selectFrom() {
      const qb: Record<string, unknown> = {};
      qb.select = () => qb;
      qb.where = () => qb;
      qb.executeTakeFirst = () =>
        Promise.resolve({
          id: 'game-frame',
          name: 'Games',
          description: null,
          logoUrl: null,
          isVerified: true,
          redirectUris: ['https://games.example.com/cb'],
        });
      return qb;
    },
  },
}));
vi.mock('$lib/server/auth/device', () => ({
  getDeviceId: () => undefined,
  isLinkedAndFresh: vi.fn(),
  canSwitch: vi.fn(),
  listAccounts: vi.fn(async () => []),
  rollDeviceCookie: vi.fn(),
  touchAccount: vi.fn(),
}));
vi.mock('$lib/server/auth/session', () => ({
  mintUserSession: vi.fn(),
  setSessionCookie: vi.fn(),
}));
vi.mock('$lib/server/auth/session-producer', () => ({
  getOrProduceSessionUser: vi.fn(async (id: number) => ({ id, username: 'owner' })),
}));

import { load } from '../+page.server';

function loadWith(scope: number | string, extra: Record<string, string> = {}) {
  const url = new URL('https://auth.civitai.com/login/oauth/authorize');
  url.searchParams.set('client_id', 'game-frame');
  url.searchParams.set('redirect_uri', 'https://games.example.com/cb');
  url.searchParams.set('scope', String(scope));
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  return load({ url, locals: { user: { id: 7 } }, cookies: {}, setHeaders } as never) as Promise<
    Record<string, unknown>
  >;
}

const setHeaders = vi.fn();

describe('consent screen load', () => {
  it('treats a request for AppStoreCatalogWrite as invalid', async () => {
    const page = await loadWith(TokenScope.UserRead | TokenScope.AppStoreCatalogWrite);
    expect(page).toEqual({ invalid: true });
  });

  it('renders an ordinary request (positive control)', async () => {
    const page = await loadWith(TokenScope.UserRead);
    expect(page).toMatchObject({ invalid: false, scopes: ['Read profile, settings & email'] });
  });

  it('forbids framing the consent screen', async () => {
    setHeaders.mockClear();
    await loadWith(TokenScope.UserRead);
    expect(setHeaders).toHaveBeenCalledWith({
      'content-security-policy': "frame-ancestors 'none'",
      'x-frame-options': 'DENY',
    });
  });
});

describe('consent screen — scope names and prompt', () => {
  it('reads scope names and keeps an openid request in the Approve form', async () => {
    const page = await loadWith('openid ModelsRead');
    expect(page).toMatchObject({ invalid: false });
    expect((page.params as Record<string, string>).scope).toBe(
      `openid ${TokenScope.UserRead | TokenScope.ModelsRead}`
    );
  });

  it('treats an unknown scope name as invalid', async () => {
    expect(await loadWith('ModelsRead Bogus')).toEqual({ invalid: true });
  });

  it('prompt=select_account opens the picker even for one account, with a way to add another', async () => {
    const page = await loadWith(TokenScope.UserRead, { prompt: 'select_account' });
    expect(page).toMatchObject({ selectAccount: true, accounts: [{ userId: 7, active: true }] });
    const add = new URL(page.addAccountUrl as string, 'https://auth.civitai.com');
    expect(add.pathname).toBe('/login');
    expect(add.searchParams.get('prompt')).toBe('select_account');
    expect(add.searchParams.get('returnUrl')).toMatch(/^\/login\/oauth\/authorize\?/);
  });
});
