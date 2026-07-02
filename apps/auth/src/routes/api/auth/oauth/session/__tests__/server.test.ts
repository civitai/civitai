import { describe, it, expect, vi, beforeEach } from 'vitest';

// Pins the missing-XFF regression fix on the first-party session-exchange endpoint. Under internal routing
// (AUTH_HUB_INTERNAL_URL → in-cluster ClusterIP) the spoke's server-to-server POST bypasses Traefik and arrives
// with NO x-forwarded-for; SvelteKit's getClientAddress() then THROWS (not empty) because ADDRESS_HEADER is
// configured — which used to 500 ~45% of first-party logins. These tests assert (a) a throwing getClientAddress
// no longer 500s and degrades the rate-limit key to the client_id (per-tenant, NOT a single global bucket that
// would 429 under load), and (b) a resolvable IP still keys the flood-guard on the IP. We stub only the
// downstream collaborators; safeClientAddress + the rate-limit-key logic under test are the real modules. The
// request is deliberately allowed to bail at the auth-code lookup (invalid_grant/400) right after the rate-limit
// check — that keeps the test focused on the IP path while still proving the response is NOT a 500.

const h = vi.hoisted(() => ({
  checkOAuthRateLimit: vi.fn().mockResolvedValue(true),
  getAuthorizationCode: vi.fn().mockResolvedValue(undefined), // bail cleanly at the code lookup → 400
  logOAuthEvent: vi.fn(),
}));

vi.mock('$lib/server/oauth/rate-limit', () => ({ checkOAuthRateLimit: h.checkOAuthRateLimit }));
vi.mock('$lib/server/oauth/model', () => ({
  oauthModel: {
    getAuthorizationCode: h.getAuthorizationCode,
    revokeAuthorizationCode: vi.fn(),
  },
}));
vi.mock('$lib/server/auth/session-producer', () => ({ getOrProduceSessionUser: vi.fn() }));
vi.mock('$lib/server/auth/session', () => ({ mintUserSession: vi.fn() }));
vi.mock('$lib/server/auth/device', () => ({ touchAccount: vi.fn() }));
vi.mock('$lib/server/oauth/oidc-nonce', () => ({ consumeOidcContext: vi.fn() }));
vi.mock('$lib/server/oauth/audit-log', () => ({ logOAuthEvent: h.logOAuthEvent }));

import { POST } from '../+server';

const CLIENT_ID = 'firstparty-civitai_com';

function makeEvent(getClientAddress: () => string) {
  return {
    request: new Request('https://auth.civitai.com/api/auth/oauth/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'auth-code', code_verifier: 'verif', client_id: CLIENT_ID }),
    }),
    getClientAddress,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.checkOAuthRateLimit.mockResolvedValue(true);
  h.getAuthorizationCode.mockResolvedValue(undefined);
});

describe('oauth/session +server — client-address resolution never 500s the exchange', () => {
  it('does NOT 500 when getClientAddress() throws, and keys the flood-guard on the client_id (per-tenant)', async () => {
    const res = await POST(
      makeEvent(() => {
        throw new Error('Could not determine clientAddress (no x-forwarded-for)');
      })
    );

    // The throw is swallowed → we reach the rate-limit check and then the code lookup, so this is a 400
    // invalid_grant (the cheap early bail), NOT a 500.
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');

    // Degraded, per-tenant key — NOT a single global 'unknown' bucket.
    expect(h.checkOAuthRateLimit).toHaveBeenCalledTimes(1);
    expect(h.checkOAuthRateLimit).toHaveBeenCalledWith('session', `client:${CLIENT_ID}`);
  });

  it('keys the flood-guard on the resolved IP when getClientAddress() returns one (unchanged behavior)', async () => {
    const res = await POST(makeEvent(() => '203.0.113.9'));

    expect(res.status).toBe(400);
    expect(h.checkOAuthRateLimit).toHaveBeenCalledWith('session', '203.0.113.9');
  });

  it('429s when the flood-guard rejects (still reached under a throwing getClientAddress)', async () => {
    h.checkOAuthRateLimit.mockResolvedValue(false);
    const res = await POST(
      makeEvent(() => {
        throw new Error('no XFF');
      })
    );
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe('rate_limited');
  });
});
