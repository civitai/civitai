import { describe, it, expect, vi, beforeEach } from 'vitest';

// Pins the missing-XFF regression fix on the first-party session-exchange endpoint. Under internal routing
// (AUTH_HUB_INTERNAL_URL → in-cluster ClusterIP) the spoke's server-to-server POST bypasses Traefik and arrives
// with NO x-forwarded-for; the endpoint now resolves the client via the canonical cf-first getClientIp (which
// returns null on a header-less request instead of throwing the way SvelteKit's getClientAddress() did). These
// tests assert (a) a null getClientIp no longer 500s and degrades the rate-limit key to the client_id (coarse
// bucket-spreading, NOT a single global bucket that would 429 under load), (b) a resolvable IP keys the
// flood-guard on the IP, and (c) the flood-guard still 429s when it rejects. We stub only the downstream
// collaborators; the rate-limit-key logic under test is the real module. The request is deliberately allowed to
// bail at the auth-code lookup (invalid_grant/400) right after the rate-limit check — that keeps the test
// focused on the IP path while still proving the response is NOT a 500.

const h = vi.hoisted(() => ({
  getClientIp: vi.fn<() => string | null>(),
  checkOAuthRateLimit: vi.fn().mockResolvedValue(true),
  getAuthorizationCode: vi.fn().mockResolvedValue(undefined), // bail cleanly at the code lookup → 400
  revokeAuthorizationCode: vi.fn().mockResolvedValue(true),
  getOrProduceSessionUser: vi.fn(),
  mintUserSession: vi.fn(),
  touchAccount: vi.fn(),
  consumeOidcContext: vi.fn().mockResolvedValue({ deviceId: undefined }),
  logOAuthEvent: vi.fn(),
}));

vi.mock('$lib/server/auth/request', () => ({ getClientIp: h.getClientIp }));
vi.mock('$lib/server/oauth/rate-limit', () => ({ checkOAuthRateLimit: h.checkOAuthRateLimit }));
vi.mock('$lib/server/oauth/model', () => ({
  oauthModel: {
    getAuthorizationCode: h.getAuthorizationCode,
    revokeAuthorizationCode: h.revokeAuthorizationCode,
  },
}));
vi.mock('$lib/server/auth/session-producer', () => ({
  getOrProduceSessionUser: h.getOrProduceSessionUser,
}));
vi.mock('$lib/server/auth/session', () => ({ mintUserSession: h.mintUserSession }));
vi.mock('$lib/server/auth/device', () => ({ touchAccount: h.touchAccount }));
vi.mock('$lib/server/oauth/oidc-nonce', () => ({ consumeOidcContext: h.consumeOidcContext }));
vi.mock('$lib/server/oauth/audit-log', () => ({ logOAuthEvent: h.logOAuthEvent }));

import { POST } from '../+server';

const CLIENT_ID = 'firstparty-civitai_com';
// base64url(sha256('verif')) — the PKCE challenge that matches the makeEvent() body's code_verifier.
const CHALLENGE_FOR_VERIF = 'lXVVZbQxbYVAs06c2FGaOLhOzC_2I6LapZzDAaDXSDM';

function makeEvent() {
  return {
    request: new Request('https://auth.civitai.com/api/auth/oauth/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'auth-code', code_verifier: 'verif', client_id: CLIENT_ID }),
    }),
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.checkOAuthRateLimit.mockResolvedValue(true);
  h.getAuthorizationCode.mockResolvedValue(undefined);
  h.revokeAuthorizationCode.mockResolvedValue(true);
  h.consumeOidcContext.mockResolvedValue({ deviceId: undefined });
});

// A valid, unexpired, first-party auth code whose PKCE challenge matches the makeEvent() verifier.
const validCode = () => ({
  client: { id: CLIENT_ID, isFirstParty: true },
  expiresAt: new Date(Date.now() + 600_000),
  codeChallengeMethod: 'S256',
  codeChallenge: CHALLENGE_FOR_VERIF,
  user: { id: 7 },
});

describe('oauth/session +server — client-IP resolution never 500s the exchange', () => {
  it('does NOT 500 when getClientIp() returns null, and keys the flood-guard on the client_id (bucket-spread)', async () => {
    h.getClientIp.mockReturnValue(null); // header-less internal-routed call

    const res = await POST(makeEvent());

    // No throw → we reach the rate-limit check and then the code lookup, so this is a 400 invalid_grant (the
    // cheap early bail), NOT a 500.
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');

    // Degraded, per-client key — NOT a single global 'unknown' bucket.
    expect(h.checkOAuthRateLimit).toHaveBeenCalledTimes(1);
    expect(h.checkOAuthRateLimit).toHaveBeenCalledWith('session', `client:${CLIENT_ID}`);
  });

  it('keys the flood-guard on the resolved IP when getClientIp() returns one', async () => {
    h.getClientIp.mockReturnValue('203.0.113.9');

    const res = await POST(makeEvent());

    expect(res.status).toBe(400);
    expect(h.checkOAuthRateLimit).toHaveBeenCalledWith('session', '203.0.113.9');
  });

  it('429s when the flood-guard rejects (still reached under a null getClientIp)', async () => {
    h.getClientIp.mockReturnValue(null);
    h.checkOAuthRateLimit.mockResolvedValue(false);

    const res = await POST(makeEvent());

    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe('rate_limited');
  });

  it('mints the session on the full happy path and degrades the audit-log ip to "unknown" when IP is null', async () => {
    h.getClientIp.mockReturnValue(null);
    h.getAuthorizationCode.mockResolvedValue(validCode());
    h.getOrProduceSessionUser.mockResolvedValue({ id: 7 });
    h.mintUserSession.mockResolvedValue('civ.jwt');

    const res = await POST(makeEvent());

    expect(res.status).toBe(200);
    expect((await res.json()) as { token: string }).toEqual({ token: 'civ.jwt', deviceId: undefined });
    // Audit log records a clear sentinel (not undefined) when the IP couldn't be resolved.
    expect(h.logOAuthEvent).toHaveBeenCalledTimes(1);
    expect(h.logOAuthEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'token.issued', userId: 7, clientId: CLIENT_ID, ip: 'unknown' })
    );
  });

  it('records the resolved IP in the audit log on the happy path', async () => {
    h.getClientIp.mockReturnValue('203.0.113.9');
    h.getAuthorizationCode.mockResolvedValue(validCode());
    h.getOrProduceSessionUser.mockResolvedValue({ id: 7 });
    h.mintUserSession.mockResolvedValue('civ.jwt');

    const res = await POST(makeEvent());

    expect(res.status).toBe(200);
    expect(h.logOAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ ip: '203.0.113.9' }));
  });
});
