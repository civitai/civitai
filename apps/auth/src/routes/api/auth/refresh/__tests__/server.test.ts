import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSysRedis, type SysRedisFake } from '../../../../../test/sys-redis.fake';

// A refresh is the same session with a fresh window: same jti, family, sign-in time and impersonation. It is
// refused once the account, or the moderator impersonating it, is banned or deleted, whatever the token says.

const DAY_MS = 24 * 60 * 60 * 1000;

const h = vi.hoisted(() => ({
  sys: undefined as unknown as SysRedisFake,
  minted: [] as { payload: Record<string, unknown>; jti?: string; expiresIn?: number }[],
  claims: {} as Record<string, unknown>,
  users: new Map<number, Record<string, unknown> | null>(),
}));

vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiAuth>()),
  isSecureCookie: () => false,
  maybeCreateSessionSigner: () => ({
    maxAge: 30 * 24 * 60 * 60,
    mintSessionToken: async (
      payload: Record<string, unknown>,
      opts: { jti?: string; expiresIn?: number }
    ) => {
      h.minted.push({ payload, ...opts });
      return 'fresh-token';
    },
  }),
}));
vi.mock('$lib/server/redis', () => ({
  getSysRedis: () => h.sys,
  getRedis: () => null,
  evalSys: (script: string, keys: string[], args: string[]) =>
    h.sys.eval(script, { keys, arguments: args }),
}));
vi.mock('$lib/server/auth/verifier', () => ({
  verifier: { verifyToken: async () => h.claims },
}));
vi.mock('$lib/server/auth/session-producer', () => ({
  getOrProduceSessionUser: async (id: number) => h.users.get(id) ?? null,
}));

import type * as CivitaiAuth from '@civitai/auth';
import { REDIS_SYS_KEYS } from '@civitai/redis';
import { POST } from '../+server';

const MOD = 100;
const USER = 200;
const iat0 = Date.now() - 10 * DAY_MS;
const impExp = Date.now() + 60 * 60 * 1000;

const event = () =>
  ({
    request: new Request('https://auth.civitai.com/api/auth/refresh', {
      method: 'POST',
      headers: { authorization: 'Bearer old-token' },
    }),
    cookies: { get: () => undefined },
  } as never);

const statusOf = async () => {
  try {
    return (await POST(event())).status;
  } catch (e) {
    return (e as { status: number }).status;
  }
};

beforeEach(() => {
  h.sys ??= makeSysRedis();
  h.sys.reset();
  h.minted = [];
  h.claims = { sub: String(USER), jti: 'j1', sid: 'family-a', iat0, signedAt: Date.now() };
  h.users = new Map([
    [USER, { id: USER }],
    [MOD, { id: MOD, isModerator: true }],
  ]);
});

describe('POST /api/auth/refresh', () => {
  it('keeps the session id, family, sign-in time and impersonation', async () => {
    h.claims = { ...h.claims, impersonatedBy: MOD, impExp };

    expect(await statusOf()).toBe(200);

    const [{ payload, jti, expiresIn }] = h.minted;
    expect(jti).toBe('j1');
    expect(payload).toMatchObject({
      sub: String(USER),
      sid: 'family-a',
      iat0,
      impersonatedBy: MOD,
      impExp,
    });
    expect(expiresIn).toBeLessThanOrEqual(60 * 60);
    expect(h.sys.hashes.get(REDIS_SYS_KEYS.SESSION.FAMILY_LIVE)?.has('family-a')).toBe(true);
  });

  it('refuses a banned account', async () => {
    h.users.set(USER, { id: USER, bannedAt: new Date() });
    expect(await statusOf()).toBe(403);
    expect(h.minted).toHaveLength(0);
  });

  it('refuses a deleted account', async () => {
    h.users.set(USER, null);
    expect(await statusOf()).toBe(403);
    expect(h.minted).toHaveLength(0);
  });

  it('refuses an impersonation session once the moderator is banned', async () => {
    h.claims = { ...h.claims, impersonatedBy: MOD, impExp };
    h.users.set(MOD, { id: MOD, isModerator: true, bannedAt: new Date() });
    expect(await statusOf()).toBe(403);
    expect(h.minted).toHaveLength(0);
  });
});
