import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Request as OAuthRequest, Response as OAuthResponse } from '@node-oauth/oauth2-server';
import { TokenScope } from '@civitai/auth/token-scope';

// A restricted account gets no AI Services token from any grant: not on issue, and not by refreshing
// one it already holds. Grants without an AI Services scope still issue.

const h = vi.hoisted(() => ({
  user: null as { muted: boolean; bannedAt: Date | null } | null,
  refreshRow: null as Record<string, unknown> | null,
  inserts: [] as Array<Record<string, unknown>>,
}));

vi.mock('$lib/server/db/db', () => {
  const select = (table: string) => {
    const qb: Record<string, unknown> = {};
    qb.select = () => qb;
    qb.selectAll = () => qb;
    qb.where = () => qb;
    qb.executeTakeFirst = async () => {
      if (table === 'User') return h.user ?? undefined;
      if (table === 'ApiKey') return h.refreshRow ?? undefined;
      if (table === 'OauthClient')
        return {
          id: 'third-party',
          grants: ['authorization_code', 'refresh_token'],
          redirectUris: ['https://app.example/cb'],
          allowedScopes: TokenScope.Full,
          allowedOrigins: [],
          isConfidential: false,
        };
      return undefined;
    };
    return qb;
  };
  return {
    db: {
      selectFrom: select,
      insertInto() {
        const qb: Record<string, unknown> = {};
        qb.values = (v: Record<string, unknown>) => (h.inserts.push(v), qb);
        qb.execute = async () => [{}];
        return qb;
      },
      deleteFrom() {
        const qb: Record<string, unknown> = {};
        qb.where = () => qb;
        qb.executeTakeFirst = async () => ({ numDeletedRows: 1n });
        qb.execute = async () => [];
        return qb;
      },
    },
  };
});
vi.mock('$lib/server/redis', () => ({ getRedis: () => null }));
vi.mock('@civitai/auth/secret-hash', () => ({
  generateSecretHash: (s: string) => `hash:${s}`,
  generateKey: () => 'k'.repeat(36),
}));

const { createOAuthTokenPair, createAppAccessToken } = await import('../token-helpers');
const { oauthServer } = await import('../server');

const USER = 4242;
const AI = TokenScope.AIServicesWrite | TokenScope.AIServicesRead;
const muted = { muted: true, bannedAt: null };
const banned = { muted: false, bannedAt: new Date() };
const inGoodStanding = { muted: false, bannedAt: null };

function refresh() {
  const body = {
    grant_type: 'refresh_token',
    refresh_token: 'civitai_old',
    client_id: 'third-party',
  };
  const req = new OAuthRequest({
    method: 'POST',
    query: {},
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(new URLSearchParams(body).toString().length),
    },
    body,
  });
  return oauthServer.token(req, new OAuthResponse({ headers: {} }));
}

beforeEach(() => {
  h.user = null;
  h.refreshRow = null;
  h.inserts.length = 0;
});

describe('AI Services grants for a restricted account', () => {
  it('issue: an account in good standing gets one', async () => {
    h.user = inGoodStanding;
    await expect(createOAuthTokenPair(USER, 'third-party', AI)).resolves.toMatchObject({
      accessToken: expect.any(String),
    });
    expect(h.inserts).toHaveLength(2);
  });

  it("names a user's tokens oauth:<client>, and only a client_credentials token oauth-cc:", async () => {
    h.user = inGoodStanding;
    await createOAuthTokenPair(USER, 'third-party', AI);
    await createAppAccessToken(USER, 'app', AI, 600);
    await createAppAccessToken(USER, 'app', AI, 600, { clientCredentials: true });
    expect(h.inserts.map((row) => row.name)).toEqual([
      'oauth:third-party',
      'oauth-refresh:third-party',
      'oauth:app',
      'oauth-cc:app',
    ]);
  });

  it.each([
    ['muted', muted],
    ['banned', banned],
  ])('issue: a %s account is refused and nothing is written', async (_label, user) => {
    h.user = user;
    await expect(createOAuthTokenPair(USER, 'third-party', AI)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      createOAuthTokenPair(USER, 'third-party', TokenScope.AIServicesRead)
    ).rejects.toMatchObject({ status: 403 });
    await expect(createAppAccessToken(USER, 'app', AI, 600)).rejects.toMatchObject({
      status: 403,
    });
    expect(h.inserts).toHaveLength(0);
  });

  it('issue: a muted account still gets a grant with no AI Services scope', async () => {
    h.user = muted;
    await createOAuthTokenPair(USER, 'third-party', TokenScope.ModelsRead);
    expect(h.inserts).toHaveLength(2);
  });

  it('refresh: an account in good standing rotates its AI Services token', async () => {
    h.user = inGoodStanding;
    h.refreshRow = { userId: USER, tokenScope: AI, expiresAt: null, clientId: 'third-party' };
    await expect(refresh()).resolves.toMatchObject({ accessToken: expect.any(String) });
    expect(h.inserts.map((row) => row.type)).toEqual(['Access', 'Refresh']);
  });

  it('refresh: a muted account cannot refresh an AI Services token it already holds', async () => {
    h.user = muted;
    h.refreshRow = { userId: USER, tokenScope: AI, expiresAt: null, clientId: 'third-party' };
    // A refusal, not the 503 the library gives any other failure, so the client stops retrying.
    await expect(refresh()).rejects.toMatchObject({ name: 'access_denied', code: 400 });
    expect(h.inserts).toHaveLength(0);
  });
});
