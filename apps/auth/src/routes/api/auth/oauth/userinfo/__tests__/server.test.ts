import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TokenScope } from '@civitai/auth/token-scope';

/** UserInfo identifies the user behind an ordinary access token, never a client-credentials one. */

const h = vi.hoisted(() => ({ tables: {} as Record<string, Record<string, unknown>[]> }));

vi.mock('$lib/server/db/db', async () => {
  const { createKyselyFake } = await import('../../../../../../test/kysely-fake');
  return { db: createKyselyFake(h.tables) };
});
vi.mock('@civitai/auth/secret-hash', () => ({ generateSecretHash: (s: string) => `hash:${s}` }));
vi.mock('$lib/server/auth/session-producer', () => ({
  getOrProduceSessionUser: async (id: number) => ({ id, username: 'owner', isModerator: true }),
}));

import { GET, POST } from '../+server';

function userinfo() {
  return GET({
    request: new Request('https://auth.civitai.com/api/auth/oauth/userinfo', {
      headers: { authorization: 'Bearer civitai_x' },
    }),
  } as never);
}

function token(tokenScope: bigint, user: { bannedAt?: Date | null; deletedAt?: Date | null } = {}) {
  h.tables.User = [{ id: 1, deletedAt: null, bannedAt: null, ...user }];
  h.tables.ApiKey = [
    { key: 'hash:civitai_x', type: 'Access', userId: 1, tokenScope, expiresAt: null },
  ];
}

beforeEach(() => {
  for (const k of Object.keys(h.tables)) delete h.tables[k];
});

describe('oauth/userinfo', () => {
  it('refuses a client-credentials token', async () => {
    token(TokenScope.UserRead | TokenScope.AppStoreCatalogWrite);
    const res = await userinfo();
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_token');
  });

  it("refuses a banned user's token", async () => {
    token(TokenScope.UserRead, { bannedAt: new Date('2026-11-01T00:00:00Z') });
    const res = await userinfo();
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_token');
  });

  it("refuses a deleted user's token, even while their session user is still cached", async () => {
    token(TokenScope.UserRead, { deletedAt: new Date('2026-11-01T00:00:00Z') });
    const res = await userinfo();
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_token');
  });

  it('answers for an ordinary access token (positive control)', async () => {
    token(TokenScope.UserRead);
    const res = await userinfo();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sub: '1', username: 'owner' });
  });

  it('answers a POST the same way (OIDC Core §5.3.1)', async () => {
    token(TokenScope.UserRead);
    const res = await POST({
      request: new Request('https://auth.civitai.com/api/auth/oauth/userinfo', {
        method: 'POST',
        headers: { authorization: 'Bearer civitai_x' },
      }),
    } as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sub: '1' });
  });
});
