import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TokenScope } from '@civitai/auth/token-scope';
import type * as CivitaiAuth from '@civitai/auth';

/**
 * The id_token names the client the OAuth library authenticated, and a body client_id that disagrees with
 * the Basic-authenticated client is refused before the grant runs.
 */

const h = vi.hoisted(() => ({
  token: vi.fn(),
  mintIdToken: vi.fn(async (claims: { aud: string }) => `id-token-for:${claims.aud}`),
}));

vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiAuth>()),
  maybeCreateSessionSigner: () => ({ mintIdToken: h.mintIdToken }),
}));
vi.mock('$lib/server/oauth/server', () => ({ oauthServer: { token: h.token } }));
vi.mock('$lib/server/oauth/oidc-nonce', () => ({
  consumeOidcContext: async () => ({ nonce: 'n', authTime: 1 }),
}));
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
vi.mock('$lib/server/oauth/rate-limit', () => ({ checkOAuthRateLimit: async () => true }));
vi.mock('$lib/server/oauth/audit-log', () => ({ logOAuthEvent: vi.fn() }));
vi.mock('$lib/server/axiom', () => ({ logAxiomError: vi.fn() }));
vi.mock('$lib/server/auth/request', () => ({ getClientIp: () => '203.0.113.9' }));

import { POST } from '../+server';

const basic = (id: string, secret: string) =>
  `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

async function exchange(fields: Record<string, string>, authorization?: string) {
  const res = await POST({
    request: new Request('https://auth.civitai.com/api/auth/oauth/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(authorization ? { authorization } : {}),
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: 'c', ...fields }),
    }),
  } as never);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  h.token.mockReset();
  h.mintIdToken.mockClear();
  // What the library resolves for a code issued to `game-frame`: the authenticated client rides on the token.
  h.token.mockImplementation(async () => {
    return {
      accessToken: 'at',
      refreshToken: 'rt',
      scope: String(TokenScope.UserRead),
      client: { id: 'game-frame' },
      user: { id: 7 },
    };
  });
});

describe('/token id_token audience', () => {
  it('refuses a body client_id that differs from the Basic-authenticated client, before the grant runs', async () => {
    const res = await exchange({ client_id: 'other-app' }, basic('game-frame', 's'));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
    expect(h.token).not.toHaveBeenCalled();
  });

  it('names the authenticated client when the body carries no client_id', async () => {
    const res = await exchange({}, basic('game-frame', 's'));
    expect(res.status).toBe(200);
    expect(res.body.id_token).toBe('id-token-for:game-frame');
  });

  it('issues normally when the body client_id matches the Basic client (positive control)', async () => {
    const res = await exchange({ client_id: 'game-frame' }, basic('game-frame', 's'));
    expect(res.status).toBe(200);
    expect(res.body.id_token).toBe('id-token-for:game-frame');
  });

  it('issues normally with body-only client credentials (positive control)', async () => {
    const res = await exchange({ client_id: 'game-frame', client_secret: 's' });
    expect(res.status).toBe(200);
    expect(res.body.id_token).toBe('id-token-for:game-frame');
  });
});
