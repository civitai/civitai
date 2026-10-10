import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { TokenScope } from '@civitai/auth/token-scope';

/**
 * `/api/auth/oauth/authorize` refuses a client_credentials-only scope before the consent check, so a
 * user is never asked for it and an approval never stores it on a consent row.
 */

const h = vi.hoisted(() => ({
  inserts: [] as unknown[],
  authorize: vi.fn(),
  consent: undefined as unknown,
}));

vi.mock('$lib/server/db/db', () => ({
  db: {
    selectFrom() {
      const qb: Record<string, unknown> = {};
      qb.select = () => qb;
      qb.where = () => qb;
      qb.executeTakeFirst = () => Promise.resolve(h.consent);
      return qb;
    },
    insertInto() {
      const qb: Record<string, unknown> = {};
      qb.values = (v: unknown) => {
        h.inserts.push(v);
        return qb;
      };
      qb.onConflict = () => qb;
      qb.execute = () => Promise.resolve([]);
      return qb;
    },
  },
}));
vi.mock('$lib/server/oauth/server', () => ({ oauthServer: { authorize: h.authorize } }));
vi.mock('$lib/server/oauth/rate-limit', () => ({ checkOAuthRateLimit: async () => true }));
vi.mock('$lib/server/oauth/audit-log', () => ({ logOAuthEvent: vi.fn() }));
vi.mock('$lib/server/oauth/oidc-nonce', () => ({ storeOidcContext: vi.fn(async () => undefined) }));
vi.mock('$lib/server/auth/device', () => ({
  getOrCreateDeviceId: () => 'dev',
  touchAccount: vi.fn(async () => undefined),
}));
vi.mock('$lib/server/auth/pending-authz', () => ({
  resolveAuthorizingUser: async () => ({ id: 7 }),
}));
vi.mock('$lib/server/auth/session-producer', () => ({ getOrProduceSessionUser: vi.fn() }));
vi.mock('$lib/server/oauth/access', () => ({ checkClientAccess: async () => ({ allowed: true }) }));
vi.mock('$lib/server/oauth/model', () => ({
  authorizeRedirectUriStore: new AsyncLocalStorage<string>(),
  resolveClientLite: async () => ({
    id: 'game-frame',
    grants: ['authorization_code', 'client_credentials'],
    redirectUris: ['https://games.example.com/cb'],
    isFirstParty: false,
    accessMode: 'open',
  }),
}));

import { POST } from '../+server';

function approve(scope: number) {
  const body = new URLSearchParams({
    client_id: 'game-frame',
    redirect_uri: 'https://games.example.com/cb',
    response_type: 'code',
    state: 's',
    code_challenge: 'c',
    code_challenge_method: 'S256',
    scope: String(scope),
    approved: 'true',
    remember: 'true',
  });
  const url = new URL('https://auth.civitai.com/api/auth/oauth/authorize');
  return POST({
    request: new Request(url, { method: 'POST', body }),
    url,
    locals: { user: { id: 7 } },
    getClientAddress: () => '203.0.113.9',
    cookies: { get: () => undefined, set: () => undefined },
  } as never);
}

beforeEach(() => {
  h.inserts.length = 0;
  h.authorize.mockReset();
  h.consent = undefined;
});

describe('authorize — client_credentials-only scopes', () => {
  it('refuses AppStoreCatalogWrite before storing any consent or issuing a code', async () => {
    const res = await approve(TokenScope.UserRead | TokenScope.AppStoreCatalogWrite);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_scope');
    expect(h.inserts).toHaveLength(0);
    expect(h.authorize).not.toHaveBeenCalled();
  });

  it('stores the consent for an ordinary scope (positive control)', async () => {
    h.authorize.mockRejectedValueOnce(new Error('stop after consent'));
    await Promise.resolve(approve(TokenScope.UserRead)).catch(() => undefined);
    expect(h.inserts).toEqual([
      expect.objectContaining({ userId: 7, clientId: 'game-frame', scope: TokenScope.UserRead }),
    ]);
  });
});
