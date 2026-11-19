import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as CivitaiAuth from '@civitai/auth';

/**
 * A refresh_token grant through the real token route, the OAuth library and the hub model, over one
 * in-memory database: it renews only for an account in good standing. Only the database, redis, the rate
 * limiter and the audit log are stubbed.
 */

const h = vi.hoisted(() => {
  // generateSecretHash salts with NEXTAUTH_SECRET, read once by @civitai/auth.
  process.env.NEXTAUTH_SECRET = `refresh-standing-test-${Math.random()}`;
  return { tables: {} as Record<string, Record<string, unknown>[]> };
});

vi.mock('$lib/server/db/db', async () => {
  const { createKyselyFake } = await import('../../../../../../test/kysely-fake');
  return { db: createKyselyFake(h.tables) };
});
vi.mock('$lib/server/redis', () => ({ getRedis: () => null }));
vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiAuth>()),
  maybeCreateSessionSigner: () => undefined,
}));
vi.mock('$lib/server/oauth/rate-limit', () => ({ checkOAuthRateLimit: vi.fn(async () => true) }));
vi.mock('$lib/server/oauth/audit-log', () => ({ logOAuthEvent: vi.fn() }));
vi.mock('$lib/server/axiom', () => ({ logAxiomError: vi.fn(async () => undefined) }));
vi.mock('$lib/server/auth/request', () => ({ getClientIp: () => '203.0.113.30' }));

import { generateKey, generateSecretHash } from '@civitai/auth/secret-hash';
import { TokenScope } from '@civitai/auth/token-scope';
import { POST as TOKEN } from '../+server';

const USER = 41;
const CLIENT = 'third-party-app';

let refreshToken: string;

function seed(user: { deletedAt?: Date | null; bannedAt?: Date | null } = {}) {
  refreshToken = `civitai_${generateKey(32)}`;
  h.tables.User = [{ id: USER, username: 'owner', deletedAt: null, bannedAt: null, ...user }];
  h.tables.OauthClient = [
    {
      id: CLIENT,
      secret: null,
      name: CLIENT,
      isConfidential: false,
      grants: ['authorization_code', 'refresh_token'],
      allowedScopes: TokenScope.UserRead,
      userId: 1,
      redirectUris: ['https://app.example/callback'],
      allowedOrigins: [],
    },
  ];
  h.tables.ApiKey = [
    {
      id: 1,
      key: generateSecretHash(refreshToken),
      type: 'Refresh',
      userId: USER,
      clientId: CLIENT,
      tokenScope: TokenScope.UserRead,
      tokenScopeWide: null,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  ];
}

async function refresh() {
  const res = await TOKEN({
    request: new Request('https://auth.civitai.com/api/auth/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT,
        refresh_token: refreshToken,
      }),
    }),
  } as never);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  for (const k of Object.keys(h.tables)) delete h.tables[k];
});

describe('/token refresh_token grant and account standing', () => {
  it('mints a new pair for an account in good standing (control)', async () => {
    seed();
    const res = await refresh();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ token_type: 'Bearer' });
    expect(typeof res.body.access_token).toBe('string');
    expect(typeof res.body.refresh_token).toBe('string');
    expect(h.tables.ApiKey.map((k) => k.type).sort()).toEqual(['Access', 'Refresh']);
    expect(h.tables.ApiKey.some((k) => k.key === generateSecretHash(refreshToken))).toBe(false);
  });

  it.each([
    ['banned', { bannedAt: new Date('2026-11-01T00:00:00Z') }],
    ['deleted', { deletedAt: new Date('2026-11-01T00:00:00Z') }],
  ])('refuses a %s account with invalid_grant and mints nothing', async (_, user) => {
    seed(user);
    const before = h.tables.ApiKey.map((k) => ({ ...k }));
    const res = await refresh();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(h.tables.ApiKey).toEqual(before);
  });
});
