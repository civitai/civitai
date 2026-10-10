import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TokenScope } from '@civitai/auth/token-scope';
import type * as CivitaiAuth from '@civitai/auth';

/**
 * `grant_type=client_credentials` through the real token route, OAuth library and hub model:
 * only the database, redis and the audit/rate-limit side effects are stubbed. The grant is the
 * client acting as itself, so it may mint only the client_credentials-only scopes, only for a
 * confidential client holding a secret, and never a refresh token.
 */

const h = vi.hoisted(() => ({
  client: undefined as Record<string, unknown> | undefined,
  inserts: [] as Array<Record<string, unknown>>,
}));

vi.mock('$lib/server/db/db', () => ({
  db: {
    selectFrom(table: string) {
      const qb: Record<string, unknown> = {};
      qb.select = () => qb;
      qb.selectAll = () => qb;
      qb.where = () => qb;
      qb.executeTakeFirst = () => Promise.resolve(table === 'OauthClient' ? h.client : undefined);
      qb.execute = () => Promise.resolve([]);
      return qb;
    },
    insertInto() {
      const qb: Record<string, unknown> = {};
      qb.values = (v: Record<string, unknown>) => {
        h.inserts.push(v);
        return qb;
      };
      qb.execute = () => Promise.resolve([{}]);
      return qb;
    },
  },
}));
vi.mock('$lib/server/redis', () => ({ getRedis: () => null }));
vi.mock('@civitai/auth/secret-hash', () => ({
  generateSecretHash: (s: string) => `hash:${s}`,
  generateKey: () => 'k'.repeat(36),
}));
vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiAuth>()),
  maybeCreateSessionSigner: () => undefined,
}));
vi.mock('$lib/server/oauth/rate-limit', () => ({ checkOAuthRateLimit: async () => true }));
vi.mock('$lib/server/oauth/audit-log', () => ({ logOAuthEvent: vi.fn() }));
vi.mock('$lib/server/axiom', () => ({ logAxiomError: vi.fn(async () => undefined) }));
vi.mock('$lib/server/auth/request', () => ({ getClientIp: () => '203.0.113.9' }));

import { POST } from '../+server';

const CATALOG = TokenScope.AppStoreCatalogWrite;
const OWNER = 1;
const SECRET = 'the-client-secret';

function confidentialClient(over: Record<string, unknown> = {}) {
  return {
    id: 'game-frame',
    userId: OWNER,
    isConfidential: true,
    secret: `hash:${SECRET}`,
    grants: ['authorization_code', 'refresh_token', 'client_credentials'],
    redirectUris: ['https://games.example.com/cb'],
    allowedOrigins: [],
    allowedScopes:
      TokenScope.UserRead | TokenScope.AIServicesRead | TokenScope.AIServicesWrite | CATALOG,
    ...over,
  };
}

async function token(scope: number | null, secret = SECRET) {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: 'game-frame',
    client_secret: secret,
  });
  if (scope !== null) body.set('scope', String(scope));
  const res = await POST({
    request: new Request('https://auth.civitai.com/api/auth/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    }),
  } as never);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  h.client = confidentialClient();
  h.inserts.length = 0;
});

describe('client_credentials grant', () => {
  it('mints an access-only token carrying the catalog bit and UserRead', async () => {
    const res = await token(CATALOG);

    expect(res.status).toBe(200);
    expect(res.body.scope).toEqual([String(CATALOG | TokenScope.UserRead)]);
    expect(res.body.expires_in).toBe(3600);
    expect(res.body).not.toHaveProperty('refresh_token');
    expect(h.inserts).toHaveLength(1);
    expect(h.inserts[0]).toMatchObject({
      type: 'Access',
      userId: OWNER,
      clientId: 'game-frame',
      tokenScope: CATALOG | TokenScope.UserRead,
    });
  });

  it('grants only UserRead when no scope is requested', async () => {
    const res = await token(null);
    expect(res.status).toBe(200);
    expect(res.body.scope).toEqual([String(TokenScope.UserRead)]);
    expect(res.body).not.toHaveProperty('refresh_token');
  });

  it('refuses a scope inside the client ceiling but outside the client_credentials cap', async () => {
    const res = await token(TokenScope.AIServicesWrite);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_scope');
    expect(h.inserts).toHaveLength(0);
  });

  it('refuses the catalog bit when the client ceiling lacks it', async () => {
    h.client = confidentialClient({ allowedScopes: TokenScope.UserRead });
    const res = await token(CATALOG);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_scope');
    expect(h.inserts).toHaveLength(0);
  });

  it('refuses a public client, whatever secret it sends', async () => {
    h.client = confidentialClient({ isConfidential: false, secret: null });
    const res = await token(CATALOG, 'anything');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(h.inserts).toHaveLength(0);
  });

  it('refuses a client without the client_credentials grant', async () => {
    h.client = confidentialClient({ grants: ['authorization_code', 'refresh_token'] });
    const res = await token(CATALOG);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unauthorized_client');
    expect(h.inserts).toHaveLength(0);
  });

  it('refuses a wrong secret', async () => {
    const res = await token(CATALOG, 'wrong');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client');
    expect(h.inserts).toHaveLength(0);
  });
});
