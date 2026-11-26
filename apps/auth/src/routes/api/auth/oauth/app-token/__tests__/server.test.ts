import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as OAuthRateLimit from '$lib/server/oauth/rate-limit';
import { TokenScope } from '@civitai/auth/token-scope';

// The db mock routes selectFrom by table so the client and consent lookups are controlled independently, and
// captures ApiKey inserts so the minted row (not just the response) is asserted.
const h = vi.hoisted(() => ({
  isInternalRequest: vi.fn(),
  checkOAuthRateLimit: vi.fn(),
  getOrProduceSessionUser: vi.fn(),
  logOAuthEvent: vi.fn(),
  rows: {} as Record<string, unknown>,
  inserts: [] as Array<Record<string, unknown>>,
  lockAppBlockSuspended: vi.fn(),
  inTransaction: false,
  insertedInTransaction: [] as boolean[],
}));

vi.mock('$lib/server/db/db', () => ({
  db: {
    selectFrom(table: string) {
      const qb: Record<string, unknown> = {};
      qb.select = () => qb;
      qb.where = () => qb;
      qb.executeTakeFirst = () => Promise.resolve(h.rows[table]);
      return qb;
    },
    insertInto() {
      const qb: Record<string, unknown> = {};
      qb.values = (v: Record<string, unknown>) => {
        h.inserts.push(v);
        h.insertedInTransaction.push(h.inTransaction);
        return qb;
      };
      qb.execute = () => Promise.resolve([{}]);
      return qb;
    },
    transaction() {
      return {
        async execute(fn: (trx: unknown) => Promise<unknown>) {
          const { db } = await import('$lib/server/db/db');
          h.inTransaction = true;
          try {
            return await fn(db);
          } finally {
            h.inTransaction = false;
          }
        },
      };
    },
  },
}));
// The lock itself is exercised on a real Postgres in app-block-mint-lock.pg.test.ts.
vi.mock('$lib/server/oauth/app-block-mint-lock', () => ({
  lockAppBlockSuspended: h.lockAppBlockSuspended,
}));
vi.mock('@civitai/auth/secret-hash', () => ({
  generateKey: () => 'k',
  generateSecretHash: (s: string) => `hash:${s}`,
}));
vi.mock('$lib/server/auth/internal', () => ({ isInternalRequest: h.isInternalRequest }));
vi.mock('$lib/server/auth/request', () => ({ getClientIp: () => '203.0.113.9' }));
vi.mock('$lib/server/oauth/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof OAuthRateLimit>()),
  checkOAuthRateLimit: h.checkOAuthRateLimit,
}));
vi.mock('$lib/server/auth/session-producer', () => ({
  getOrProduceSessionUser: h.getOrProduceSessionUser,
}));
vi.mock('$lib/server/oauth/audit-log', () => ({ logOAuthEvent: h.logOAuthEvent }));

import { POST } from '../+server';

const CLIENT_ID = 'app-block-client';
const REQUESTED = TokenScope.UserRead | TokenScope.AIServicesWrite;

function call(body: Record<string, unknown>) {
  return POST({
    request: new Request('https://auth.civitai.com/api/auth/oauth/app-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The main app sends the scope as a JSON number (JSON has no bigint).
      body: JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? Number(v) : v)),
    }),
  } as never);
}

const body = { userId: 7, clientId: CLIENT_ID, scope: REQUESTED, ttlSeconds: 600 };

beforeEach(() => {
  vi.clearAllMocks();
  h.inserts.length = 0;
  h.insertedInTransaction.length = 0;
  h.lockAppBlockSuspended.mockResolvedValue(false);
  h.isInternalRequest.mockReturnValue(true);
  h.checkOAuthRateLimit.mockResolvedValue(true);
  h.getOrProduceSessionUser.mockResolvedValue({ id: 7 });
  h.rows = {
    OauthClient: { allowedScopes: REQUESTED, accessMode: 'open', grants: [] },
    OauthConsent: { scope: REQUESTED },
    User: { muted: false, bannedAt: null },
  };
});

describe('oauth/app-token +server', () => {
  it('mints nothing for the remix apps client, whose row the seed migration inserts', async () => {
    // Even with a consent row: each of its two guards refuses on its own.
    const remixClient = { allowedScopes: 0, accessMode: 'disabled', grants: [] };
    h.rows.OauthClient = remixClient;
    expect((await call({ ...body, clientId: 'civitai-remix-apps' })).status).toBe(403);
    h.rows.OauthClient = { ...remixClient, accessMode: 'open' };
    const res = await call({ ...body, clientId: 'civitai-remix-apps' });
    expect(((await res.json()) as { error: string }).error).toBe('invalid_scope');
    expect(h.inserts).toHaveLength(0);
    // POSITIVE CONTROL: with scopes and access, the same request mints.
    h.rows.OauthClient = { allowedScopes: REQUESTED, accessMode: 'open', grants: [] };
    expect((await call({ ...body, clientId: 'civitai-remix-apps' })).status).toBe(200);
  });

  it('🔴 mints nothing for ANOTHER user’s App Assistant client, even with a consent row for it', async () => {
    // User 7 asks for a token under user 8's App Assistant client; the client and consent rows
    // exist and would otherwise pass every check below.
    const res = await call({ ...body, clientId: 'appassist-8' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_client');
    expect(h.inserts).toHaveLength(0);
    // A prefix lookalike is not the user's own client either.
    expect((await call({ ...body, clientId: 'appassist-77' })).status).toBe(400);
    expect(h.inserts).toHaveLength(0);
    // Control: the user's OWN App Assistant client mints.
    expect((await call({ ...body, clientId: 'appassist-7' })).status).toBe(200);
    expect(h.inserts).toHaveLength(1);
  });

  it('mints nothing for an impersonation', async () => {
    const res = await call({ ...body, impersonatedBy: 3 });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('impersonation_refused');
    expect(h.inserts).toHaveLength(0);
    // Control: the same request with no impersonation mints.
    expect((await call({ ...body, impersonatedBy: null })).status).toBe(200);
    expect(h.inserts).toHaveLength(1);
  });

  it('mints nothing for a service client, which acts only as itself', async () => {
    h.rows.OauthClient = {
      allowedScopes: REQUESTED,
      accessMode: 'open',
      grants: ['urn:civitai:grant:service'],
    };
    const res = await call(body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_client');
    expect(h.inserts).toHaveLength(0);
    // Control: the same row without the service grant mints.
    h.rows.OauthClient = { allowedScopes: REQUESTED, accessMode: 'open', grants: [] };
    expect((await call(body)).status).toBe(200);
  });

  it('403 when the client’s app block is suspended, and the token is minted under the lock otherwise', async () => {
    h.lockAppBlockSuspended.mockResolvedValue(true);
    const res = await call(body);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('access_denied');
    expect(h.inserts).toHaveLength(0);
    expect(h.lockAppBlockSuspended).toHaveBeenCalledWith(expect.anything(), CLIENT_ID);

    // Control: the same request mints once the block is not suspended, inside the lock's transaction.
    h.lockAppBlockSuspended.mockResolvedValue(false);
    expect((await call(body)).status).toBe(200);
    expect(h.insertedInTransaction).toEqual([true]);
  });

  it('requires the internal token', async () => {
    h.isInternalRequest.mockReturnValue(false);
    const res = await call(body);
    expect(res.status).toBe(401);
    expect(h.inserts).toHaveLength(0);
  });

  it('403 consent_required when no consent row exists', async () => {
    h.rows.OauthConsent = undefined;
    const res = await call(body);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('consent_required');
  });

  it('403 when the requested scope is wider than the consent', async () => {
    h.rows.OauthConsent = { scope: TokenScope.UserRead };
    const res = await call(body);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('consent_required');
    expect(h.inserts).toHaveLength(0);
  });

  /**
   * 🔴 SEAM GUARD (civitai#5127). The forced `scope |= TokenScope.UserRead` in this
   * handler is what turns withholding `UserRead` from the mirrored `OauthConsent` row
   * into an actual refusal: main-app `syncOauthConsentFromGrant` writes that bit only
   * when the viewer really granted `user:read:self`, and THIS handler is what then
   * declines to mint. The relationship spans two codebases, so no main-app test can
   * observe it — and if the force were ever dropped here, a narrower request would
   * start minting against a consent row that never authorised `UserRead`, silently
   * reviving the bypass.
   *
   * The request is DELIBERATELY not wider than the consent row (`AIServicesWrite` vs
   * `AIServicesWrite`), so this case is unreachable through the "wider than the
   * consent" test above: without the forced OR it would be a 200.
   */
  it('403 when the consent row omits UserRead, even for a request that omits it too', async () => {
    h.rows.OauthConsent = { scope: TokenScope.AIServicesWrite };
    const res = await call({ ...body, scope: TokenScope.AIServicesWrite });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('consent_required');
    expect(h.inserts).toHaveLength(0);
  });

  it('mints one Access row bound to the client with the ttl and UserRead, and no refresh row', async () => {
    const res = await call({ ...body, scope: TokenScope.AIServicesWrite });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;

    expect(h.inserts).toHaveLength(1);
    const [row] = h.inserts;
    expect(row.type).toBe('Access');
    expect(row.clientId).toBe(CLIENT_ID);
    expect(row.userId).toBe(7);
    // UserRead (1) | AIServicesWrite (32768), in both scope columns.
    expect(row.tokenScope).toBe(32769);
    expect(row.tokenScopeWide).toBe('32769');
    expect(row.key).toBe(`hash:${json.access_token as string}`);
    const expiresMs = (row.expiresAt as Date).getTime() - Date.now();
    expect(Math.abs(expiresMs - 600_000)).toBeLessThan(5000);

    expect(json.token_type).toBe('Bearer');
    expect(json.expires_in).toBe(600);
    expect(json.expires_at).toBe((row.expiresAt as Date).toISOString());
    expect(json.scope).toBe(32769);
    expect(h.logOAuthEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'token.issued', metadata: { grant_type: 'app_token' } })
    );
  });
});

describe('oauth/app-token +server — scopes past bit 30', () => {
  // UserRead | AppsRead (2^31) | AppDataRead (2^32), as the main app sends it: a JSON number.
  const APPS = 6442450945;

  it('passes the bounds check, and mints with bits 31 and 32 when the consent covers them', async () => {
    h.rows.OauthClient = { allowedScopes: APPS, accessMode: 'open', grants: [] };
    h.rows.OauthConsent = { scope: APPS };
    const res = await call({ ...body, scope: APPS });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).scope).toBe(APPS);
    const [row] = h.inserts;
    expect(row.tokenScopeWide).toBe('6442450945');
    expect(row.tokenScope).toBe(1);
  });

  it('refuses them when the consent does not cover them (consent_required, not invalid_scope)', async () => {
    h.rows.OauthClient = { allowedScopes: APPS, accessMode: 'open', grants: [] };
    h.rows.OauthConsent = { scope: 1 };
    const res = await call({ ...body, scope: APPS });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('consent_required');
  });

  it('still refuses a bit past the defined scopes', async () => {
    const res = await call({ ...body, scope: 8589934592 }); // 2^33: no such scope
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_scope');
  });
});

describe('oauth/app-token +server — client_credentials-only scopes', () => {
  it('400 invalid_scope for AppStoreCatalogWrite, even with a ceiling and consent carrying it', async () => {
    const scope = TokenScope.UserRead | TokenScope.AppStoreCatalogWrite;
    h.rows = {
      OauthClient: { allowedScopes: scope, accessMode: 'open', grants: [] },
      OauthConsent: { scope },
    };
    const res = await call({ ...body, scope });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_scope');
    expect(h.inserts).toHaveLength(0);
  });
});
