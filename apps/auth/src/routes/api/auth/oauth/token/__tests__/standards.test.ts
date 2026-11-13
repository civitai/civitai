import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TokenScope } from '@civitai/auth/token-scope';
import type * as CivitaiAuth from '@civitai/auth';

/**
 * `/token` against the standards a generic client assumes: an id_token for an `openid` request with no
 * nonce (OIDC Core §3.1.3.3) and scope names on client_credentials (RFC 6749 §3.3). The device grant
 * here (RFC 8628 §3.4) is tested with the poll itself, in device-token/__tests__.
 */

const h = vi.hoisted(() => ({
  token: vi.fn(),
  mintIdToken: vi.fn(async () => 'id-token'),
  oidcContext: {} as Record<string, unknown>,
}));

vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiAuth>()),
  maybeCreateSessionSigner: () => ({ mintIdToken: h.mintIdToken }),
}));
vi.mock('$lib/server/oauth/server', () => ({ oauthServer: { token: h.token } }));
vi.mock('$lib/server/oauth/oidc-nonce', () => ({ consumeOidcContext: async () => h.oidcContext }));
vi.mock('$lib/server/db/db', () => ({
  db: {
    selectFrom() {
      const qb: Record<string, unknown> = {};
      qb.select = () => qb;
      qb.where = () => qb;
      qb.executeTakeFirst = async () => ({
        id: 'game-frame',
        isConfidential: true,
        allowedOrigins: [],
      });
      return qb;
    },
  },
}));
vi.mock('$lib/server/oauth/rate-limit', () => ({
  checkOAuthRateLimit: async () => true,
}));
vi.mock('$lib/server/oauth/audit-log', () => ({ logOAuthEvent: vi.fn() }));
vi.mock('$lib/server/axiom', () => ({ logAxiomError: vi.fn() }));
vi.mock('$lib/server/auth/request', () => ({ getClientIp: () => '203.0.113.9' }));

import { POST } from '../+server';

async function call(fields: Record<string, string>) {
  return POST({
    request: new Request('https://auth.civitai.com/api/auth/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    }),
  } as never);
}

const codeExchange = {
  grant_type: 'authorization_code',
  code: 'c',
  client_id: 'game-frame',
  client_secret: 's',
};

beforeEach(() => {
  h.token.mockReset();
  h.token.mockResolvedValue({
    accessToken: 'at',
    refreshToken: 'rt',
    scope: String(TokenScope.UserRead),
    client: { id: 'game-frame' },
    user: { id: 7 },
  });
  h.mintIdToken.mockClear();
  h.oidcContext = {};
});

describe('/token id_token', () => {
  it('issues an id_token for an openid request that carried no nonce', async () => {
    h.oidcContext = { openid: true, authTime: 1 };
    const body = (await (await call(codeExchange)).json()) as Record<string, unknown>;
    expect(body.id_token).toBe('id-token');
    expect(h.mintIdToken).toHaveBeenCalledWith(expect.objectContaining({ nonce: undefined }));
  });

  it('still issues one for a nonce alone, as our own sign-in sends', async () => {
    h.oidcContext = { nonce: 'n', authTime: 1 };
    const body = (await (await call(codeExchange)).json()) as Record<string, unknown>;
    expect(body.id_token).toBe('id-token');
  });
});

describe('/token client_credentials scope', () => {
  it('converts scope names to the bitmask the library validates', async () => {
    await call({
      grant_type: 'client_credentials',
      client_id: 'game-frame',
      client_secret: 's',
      scope: 'AppStoreCatalogWrite',
    });
    const req = h.token.mock.calls[0][0] as { body: Record<string, string> };
    expect(req.body.scope).toBe(String(TokenScope.AppStoreCatalogWrite));
  });

  it('refuses an unknown scope name before the grant runs', async () => {
    const res = await call({
      grant_type: 'client_credentials',
      client_id: 'game-frame',
      client_secret: 's',
      scope: 'Bogus',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_scope');
    expect(h.token).not.toHaveBeenCalled();
  });
});
