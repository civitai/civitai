import { describe, it, expect, vi, beforeEach } from 'vitest';
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
        return qb;
      };
      qb.execute = () => Promise.resolve([{}]);
      return qb;
    },
  },
}));
vi.mock('@civitai/auth/secret-hash', () => ({
  generateKey: () => 'k',
  generateSecretHash: (s: string) => `hash:${s}`,
}));
vi.mock('$lib/server/auth/internal', () => ({ isInternalRequest: h.isInternalRequest }));
vi.mock('$lib/server/auth/request', () => ({ getClientIp: () => '203.0.113.9' }));
vi.mock('$lib/server/oauth/rate-limit', () => ({ checkOAuthRateLimit: h.checkOAuthRateLimit }));
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
      body: JSON.stringify(body),
    }),
  } as never);
}

const body = { userId: 7, clientId: CLIENT_ID, scope: REQUESTED, ttlSeconds: 600 };

beforeEach(() => {
  vi.clearAllMocks();
  h.inserts.length = 0;
  h.isInternalRequest.mockReturnValue(true);
  h.checkOAuthRateLimit.mockResolvedValue(true);
  h.getOrProduceSessionUser.mockResolvedValue({ id: 7 });
  h.rows = {
    OauthClient: { allowedScopes: REQUESTED, accessMode: 'open' },
    OauthConsent: { scope: REQUESTED },
  };
});

describe('oauth/app-token +server', () => {
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
    expect(row.tokenScope).toBe(REQUESTED);
    expect(row.key).toBe(`hash:${json.access_token as string}`);
    const expiresMs = (row.expiresAt as Date).getTime() - Date.now();
    expect(Math.abs(expiresMs - 600_000)).toBeLessThan(5000);

    expect(json.token_type).toBe('Bearer');
    expect(json.expires_in).toBe(600);
    expect(json.expires_at).toBe((row.expiresAt as Date).toISOString());
    expect(json.scope).toBe(REQUESTED);
    expect(h.logOAuthEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'token.issued', metadata: { grant_type: 'app_token' } })
    );
  });
});
