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
  listAccounts: vi.fn(async () => []),
  rollDeviceCookie: vi.fn(),
  touchAccount: vi.fn(),
}));
vi.mock('$lib/server/auth/session', () => ({
  mintUserSession: vi.fn(),
  setSessionCookie: vi.fn(),
}));
vi.mock('$lib/server/auth/session-producer', () => ({ getOrProduceSessionUser: vi.fn() }));

import { load } from '../+page.server';

function loadWith(scope: number) {
  const url = new URL('https://auth.civitai.com/login/oauth/authorize');
  url.searchParams.set('client_id', 'game-frame');
  url.searchParams.set('redirect_uri', 'https://games.example.com/cb');
  url.searchParams.set('scope', String(scope));
  return load({ url, locals: { user: { id: 7 } }, cookies: {} } as never) as Promise<
    Record<string, unknown>
  >;
}

describe('consent screen load', () => {
  it('treats a request for AppStoreCatalogWrite as invalid', async () => {
    const page = await loadWith(TokenScope.UserRead | TokenScope.AppStoreCatalogWrite);
    expect(page).toEqual({ invalid: true });
  });

  it('renders an ordinary request (positive control)', async () => {
    const page = await loadWith(TokenScope.UserRead);
    expect(page).toMatchObject({ invalid: false, scopes: ['Read profile, settings & email'] });
  });
});
