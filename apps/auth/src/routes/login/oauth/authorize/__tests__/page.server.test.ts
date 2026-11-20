import { beforeEach, describe, it, expect, vi } from 'vitest';
import { TokenScope } from '@civitai/auth/token-scope';

/** The consent screen never renders a client_credentials-only scope for a user to approve. */

const consentRow = vi.hoisted(() => ({
  current: undefined as Record<string, unknown> | undefined,
}));
vi.mock('$lib/server/db/db', () => ({
  db: {
    selectFrom(table: string) {
      const qb: Record<string, unknown> = {};
      qb.select = () => qb;
      qb.where = () => qb;
      if (table === 'OauthConsent') {
        qb.executeTakeFirst = () => Promise.resolve(consentRow.current);
        return qb;
      }
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

const { getGrantedScope } = vi.hoisted(() => ({
  getGrantedScope: vi.fn(async (): Promise<bigint | null> => null),
}));
vi.mock('$lib/server/oauth/granted-scope', () => ({ getGrantedScope }));
const flags = vi.hoisted(() => ({ offlineGrant: false }));
vi.mock('$lib/server/flipt', () => ({
  isGlobalFlagOn: async (flag: string) => flag === 'oauth-offline-grant' && flags.offlineGrant,
}));

import { load } from '../+page.server';

function loadWith(scope: bigint | string, extra: Record<string, string> = {}) {
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
    expect(page).toMatchObject({
      invalid: false,
      scopes: [{ label: 'Read profile, settings & email', isNew: false }],
    });
  });

  it('lists the Apps permissions (bits 31, 32) and submits them in the Approve form', async () => {
    const page = await loadWith('AppsRead AppDataRead');
    expect(page).toMatchObject({
      invalid: false,
      scopes: [
        { label: 'Read profile, settings & email', isNew: false },
        { label: 'See the Apps available to you', isNew: false },
        { label: 'See your own data in Apps', isNew: false },
      ],
    });
    expect((page.params as Record<string, string>).scope).toBe('6442450945');
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

describe('consent screen — permissions new to this app', () => {
  const READ = 'Read profile, settings & email';
  const MODELS = 'Browse & download models';
  const MEDIA = 'View images, videos & posts';
  const request = TokenScope.ModelsRead | TokenScope.MediaRead;

  it('marks only the permissions the app was not granted before', async () => {
    getGrantedScope.mockResolvedValueOnce(TokenScope.UserRead | TokenScope.ModelsRead);
    const page = await loadWith(request);
    expect(page.scopes).toEqual([
      { label: READ, isNew: false },
      { label: MODELS, isNew: false },
      { label: MEDIA, isNew: true },
    ]);
  });

  it('marks nothing on a first consent', async () => {
    getGrantedScope.mockResolvedValueOnce(null);
    const page = await loadWith(request);
    expect(page.scopes).toEqual([
      { label: READ, isNew: false },
      { label: MODELS, isNew: false },
      { label: MEDIA, isNew: false },
    ]);
  });

  it('looks up what this signed-in user granted this app', async () => {
    getGrantedScope.mockClear();
    await loadWith(request);
    expect(getGrantedScope).toHaveBeenCalledWith(7, 'game-frame');
  });
});

describe('consent screen load — the offline line', () => {
  const ask = { offline_buzz_limit: '500', offline_buzz_period: 'week' };
  beforeEach(() => {
    consentRow.current = undefined;
  });

  it('with the offline-grant flag off, is not shown and the Approve form is unchanged', async () => {
    flags.offlineGrant = false;
    const page = await loadWith(`offline_access ${TokenScope.UserRead}`, ask);
    expect(page.offline ?? null).toBeNull();
    expect((page.params as Record<string, string>).scope).toBe(String(TokenScope.UserRead));
    expect(page.params).not.toHaveProperty('offline_buzz_limit');
  });

  it('with the flag on, is shown with the app’s proposed cap, and the form keeps offline_access', async () => {
    flags.offlineGrant = true;
    const page = await loadWith(`offline_access ${TokenScope.UserRead}`, ask);
    expect(page.offline).toEqual({
      cap: { limit: 500, period: 'week' },
      custom: false,
      granted: false,
    });
    expect(page.params).toMatchObject({
      scope: `offline_access ${TokenScope.UserRead}`,
      offline_buzz_limit: '500',
      offline_buzz_period: 'week',
    });
  });

  it('with the flag on, is not shown when the app did not ask for offline access', async () => {
    flags.offlineGrant = true;
    const page = await loadWith(TokenScope.UserRead, ask);
    expect(page.offline ?? null).toBeNull();
    expect((page.params as Record<string, string>).scope).toBe(String(TokenScope.UserRead));
  });

  it('starts ticked when this app already holds the grant, prefilled with its current cap', async () => {
    flags.offlineGrant = true;
    consentRow.current = {
      scope: 1,
      offlineGrantedAt: new Date('2026-11-01T00:00:00Z'),
      buzzLimit: [{ type: 'sliding', limit: 800, window: 'day', unit: 30 }],
    };
    const page = await loadWith(`offline_access ${TokenScope.UserRead}`, ask);
    expect(page.offline).toEqual({
      cap: { limit: 800, period: 'month' },
      custom: false,
      granted: true,
    });
  });

  it('starts unticked when the consent exists without the grant', async () => {
    flags.offlineGrant = true;
    consentRow.current = { scope: 1, offlineGrantedAt: null, buzzLimit: null };
    const page = await loadWith(`offline_access ${TokenScope.UserRead}`, ask);
    expect(page.offline).toMatchObject({ granted: false });
  });

  it('marks a cap the fields cannot show as custom, with blank fields, never the app’s proposal', async () => {
    flags.offlineGrant = true;
    consentRow.current = {
      scope: 1,
      offlineGrantedAt: null,
      buzzLimit: [
        { type: 'sliding', limit: 300, window: 'hour', unit: 1 },
        { type: 'absolute', limit: 9000 },
      ],
    };
    const page = await loadWith(`offline_access ${TokenScope.UserRead}`, ask);
    expect(page.offline).toEqual({ cap: null, custom: true, granted: false });
  });
});
