import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenScope } from '@civitai/auth/token-scope';

// A first-party code is redeemed at /api/auth/oauth/session for a session; /token must not turn it
// into an API token.

const h = vi.hoisted(() => ({
  token: vi.fn(),
  getAuthorizationCode: vi.fn(),
}));

vi.mock('$lib/server/oauth/server', () => ({ oauthServer: { token: h.token } }));
vi.mock('$lib/server/oauth/model', () => ({
  oauthModel: { getAuthorizationCode: h.getAuthorizationCode },
}));
vi.mock('$lib/server/oauth/oidc-nonce', () => ({ consumeOidcContext: async () => ({}) }));
vi.mock('$lib/server/db/db', () => ({
  db: {
    selectFrom() {
      const qb: Record<string, unknown> = {};
      qb.select = () => qb;
      qb.where = () => qb;
      qb.executeTakeFirst = async () => ({ id: 'x', isConfidential: true, allowedOrigins: [] });
      return qb;
    },
  },
}));
vi.mock('$lib/server/oauth/rate-limit', () => ({ checkOAuthRateLimit: async () => true }));
vi.mock('$lib/server/oauth/audit-log', () => ({ logOAuthEvent: vi.fn() }));
vi.mock('$lib/server/axiom', () => ({ logAxiomError: vi.fn() }));
vi.mock('$lib/server/auth/request', () => ({ getClientIp: () => '203.0.113.9' }));

import { POST } from '../+server';

const exchange = () =>
  POST({
    request: new Request('https://auth.civitai.com/api/auth/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: 'c', client_id: 'x' }),
    }),
  } as never);

beforeEach(() => {
  h.token.mockReset();
  h.token.mockResolvedValue({
    accessToken: 'at',
    scope: String(TokenScope.UserRead),
    client: { id: 'x', isConfidential: true, allowedOrigins: [] },
    user: { id: 7 },
  });
});

describe('/token authorization_code', () => {
  it('refuses a first-party code and issues nothing', async () => {
    h.getAuthorizationCode.mockResolvedValue({ client: { id: 'x', isFirstParty: true } });
    const res = await exchange();
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'unauthorized_client' });
    expect(h.token).not.toHaveBeenCalled();
  });

  it("exchanges a registered app's code", async () => {
    h.getAuthorizationCode.mockResolvedValue({ client: { id: 'x', isFirstParty: false } });
    const res = await exchange();
    expect(res.status).toBe(200);
    expect(h.token).toHaveBeenCalledTimes(1);
  });

  it('issues nothing when the code lookup fails', async () => {
    h.getAuthorizationCode.mockRejectedValue(new Error('redis down'));
    const res = await exchange();
    expect(res.status).toBe(503);
    expect(h.token).not.toHaveBeenCalled();
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it("leaves an unknown code to the library's own error", async () => {
    h.getAuthorizationCode.mockResolvedValue(false);
    await exchange();
    expect(h.token).toHaveBeenCalledTimes(1);
  });
});
