import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TokenScope } from '@civitai/auth/token-scope';

/** UserInfo identifies the user behind an ordinary access token, never a client-credentials one. */

const h = vi.hoisted(() => ({ apiKey: undefined as unknown }));

vi.mock('$lib/server/db/db', () => ({
  db: {
    selectFrom(table: string) {
      const qb: Record<string, unknown> = {};
      qb.select = () => qb;
      qb.where = () => qb;
      qb.executeTakeFirst = () => Promise.resolve(table === 'ApiKey' ? h.apiKey : undefined);
      qb.execute = () => Promise.resolve([]);
      return qb;
    },
  },
}));
vi.mock('@civitai/auth/secret-hash', () => ({ generateSecretHash: (s: string) => `hash:${s}` }));
vi.mock('$lib/server/auth/session-producer', () => ({
  getOrProduceSessionUser: async (id: number) => ({ id, username: 'owner', isModerator: true }),
}));

import { GET } from '../+server';

function userinfo() {
  return GET({
    request: new Request('https://auth.civitai.com/api/auth/oauth/userinfo', {
      headers: { authorization: 'Bearer civitai_x' },
    }),
  } as never);
}

beforeEach(() => {
  h.apiKey = undefined;
});

describe('oauth/userinfo', () => {
  it('refuses a client-credentials token', async () => {
    h.apiKey = { userId: 1, tokenScope: TokenScope.UserRead | TokenScope.AppStoreCatalogWrite };
    const res = await userinfo();
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_token');
  });

  it('answers for an ordinary access token (positive control)', async () => {
    h.apiKey = { userId: 1, tokenScope: TokenScope.UserRead };
    const res = await userinfo();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sub: '1', username: 'owner' });
  });
});
