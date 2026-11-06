import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSysRedis, type SysRedisFake } from '../test/sys-redis.fake';

// The hub honours its own session cookie while the family was used within 30 days, or the token was signed
// within 30 days, and re-signs it on a page navigation once it is older than the update age. Runs the real
// hooks and liveness records over an in-memory sys redis.

const h = vi.hoisted(() => ({
  internal: (process.env.AUTH_INTERNAL_TOKEN = 'internal-secret'),
  users: new Map<number, Record<string, unknown>>(),
  sys: undefined as unknown as SysRedisFake,
  tokens: new Map<string, Record<string, unknown>>(),
  minted: [] as { payload: Record<string, unknown>; jti: string }[],
}));

vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiAuth>()),
  maybeCreateSessionSigner: () => ({
    maxAge: 3600,
    mintSessionToken: async (payload: Record<string, unknown>, opts: { jti: string }) => {
      h.minted.push({ payload, jti: opts.jti });
      return 'rolled-token';
    },
  }),
}));
vi.mock('$lib/server/redis', () => ({
  getSysRedis: () => h.sys,
  getRedis: () => null,
  evalSys: (script: string, keys: string[], args: string[]) =>
    h.sys.eval(script, { keys, arguments: args }),
}));
vi.mock('$lib/server/axiom', () => ({
  logAxiomError: vi.fn(),
  logToAxiom: vi.fn(async () => undefined),
}));
vi.mock('$lib/server/db/db', () => ({ db: {} }));
vi.mock('$lib/server/auth/session-producer', () => ({
  getOrProduceSessionUser: async (id: number) => h.users.get(id) ?? { id },
}));
vi.mock('$lib/server/auth/verifier', () => ({
  verifier: { verifyToken: async (token: string) => h.tokens.get(token) ?? null },
  signatureVerifier: { verifyToken: async (token: string) => h.tokens.get(token) ?? null },
}));

import type * as CivitaiAuth from '@civitai/auth';
import { REDIS_SYS_KEYS } from '@civitai/redis';
import { handle } from '../hooks.server';
import { deviceCookieName } from '@civitai/auth';
import { SESSION_COOKIE } from '$lib/server/auth/session';
import { POST as refreshPost } from '../routes/api/auth/refresh/+server';
import { GET as identityGet } from '../routes/api/auth/identity/+server';

const DAY_MS = 24 * 60 * 60 * 1000;
const LIVE = REDIS_SYS_KEYS.SESSION.FAMILY_LIVE;

async function visit(opts: { navigate?: boolean } = {}) {
  const set = vi.fn();
  const event = {
    url: new URL('https://auth.civitai.com/login'),
    route: { id: '/login' },
    request: new Request('https://auth.civitai.com/login', {
      headers: opts.navigate ? { 'sec-fetch-mode': 'navigate' } : {},
    }),
    cookies: {
      get: (name: string) =>
        name === SESSION_COOKIE ? 'hub-token' : name === deviceCookieName() ? 'dev-d' : undefined,
      set,
      delete: vi.fn(),
    },
    locals: {} as Record<string, unknown>,
  };
  await handle({ event, resolve: async () => new Response('ok') } as never);
  return { locals: event.locals, set };
}

const hubToken = (signedAgoMs: number, extra: Record<string, unknown> = {}) =>
  h.tokens.set('hub-token', {
    sub: '100',
    jti: 'hub-jti',
    sid: 'fam-a',
    iat0: Date.now() - signedAgoMs,
    signedAt: Date.now() - signedAgoMs,
    ...extra,
  });

const cookieJar = { get: (name: string) => (name === SESSION_COOKIE ? 'hub-token' : undefined) };

async function status(run: () => Response | Promise<Response>) {
  try {
    return (await run()).status;
  } catch (e) {
    return (e as { status: number }).status;
  }
}

const refreshByCookie = () =>
  status(() =>
    refreshPost({
      request: new Request('https://auth.civitai.com/api/auth/refresh', { method: 'POST' }),
      cookies: cookieJar,
    } as never)
  );

const refreshInternal = (
  bodyToken = 'hub-token',
  cookies: { get: (name: string) => string | undefined } = { get: () => undefined }
) =>
  status(() =>
    refreshPost({
      request: new Request('https://auth.civitai.com/api/auth/refresh', {
        method: 'POST',
        headers: { authorization: 'Bearer internal-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ token: bodyToken }),
      }),
      cookies,
    } as never)
  );

const identity = (bearer?: string) =>
  status(() =>
    identityGet({
      url: new URL('https://auth.civitai.com/api/auth/identity'),
      request: new Request('https://auth.civitai.com/api/auth/identity', {
        headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      }),
      cookies: cookieJar,
    } as never)
  );

const tracked = (jti: string) => [...h.sys.hashes.values()].some((fields) => fields.has(jti));

beforeEach(() => {
  h.sys ??= makeSysRedis();
  h.sys.reset();
  h.tokens.clear();
  h.users.clear();
  h.minted = [];
});
afterEach(() => {
  delete process.env.CIVITAI_MODERATION_USER_ID;
});

describe("the hub's own session cookie", () => {
  it('is honoured within 30 days of signing with no liveness record, and records liveness', async () => {
    hubToken(10 * DAY_MS);

    const { locals } = await visit();

    expect(locals.session).toBeDefined();
    expect(h.sys.hashes.get(LIVE)?.has('fam-a')).toBe(true);
  });

  it('is honoured past 30 days while its family is live', async () => {
    hubToken(40 * DAY_MS);
    await h.sys.hSet(LIVE, 'fam-a', String(Date.now()));

    expect((await visit()).locals.session).toBeDefined();
  });

  it('is not honoured past 30 days when its family has not been used', async () => {
    hubToken(40 * DAY_MS);

    const { locals } = await visit();

    expect(locals.session).toBeUndefined();
    expect(locals.user).toBeUndefined();
    expect(h.sys.hashes.get(LIVE)?.has('fam-a')).toBeFalsy();
  });
});

describe('a session sent by a service', () => {
  it('is accepted however long its family has been idle', async () => {
    hubToken(40 * DAY_MS);
    const event = {
      url: new URL('https://auth.civitai.com/api/auth/accounts'),
      route: { id: '/api/auth/accounts' },
      request: new Request('https://auth.civitai.com/api/auth/accounts', {
        method: 'POST',
        headers: { authorization: 'Bearer internal-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'hub-token' }),
      }),
      cookies: { get: () => undefined, set: vi.fn(), delete: vi.fn() },
      locals: {} as Record<string, unknown>,
    };

    await handle({ event, resolve: async () => new Response('ok') } as never);

    expect(event.locals.session).toBeDefined();
  });
});

describe('liveness that cannot be read', () => {
  it('honours the cookie when the liveness lookup fails', async () => {
    hubToken(40 * DAY_MS);
    const real = h.sys.hGet;
    h.sys.hGet = async () => {
      throw new Error('redis blip');
    };
    try {
      expect((await visit()).locals.session).toBeDefined();
    } finally {
      h.sys.hGet = real;
    }
  });
});

describe('refresh and identity', () => {
  it('a cookie the hub no longer honours is not refreshed and records no use', async () => {
    hubToken(40 * DAY_MS);

    expect(await refreshByCookie()).toBe(401);
    expect(h.minted).toHaveLength(0);
    expect(h.sys.hashes.get(LIVE)?.has('fam-a')).toBeFalsy();
  });

  it('the same session sent by a service is refreshed and re-tracked', async () => {
    hubToken(40 * DAY_MS);

    expect(await refreshInternal()).toBe(200);
    expect(h.minted[0].jti).toBe('hub-jti');
    expect(tracked('hub-jti')).toBe(true);
  });

  it('a service call with no session in its body is refused, whatever cookie it forwards', async () => {
    hubToken(10 * DAY_MS);

    expect(await refreshInternal('', cookieJar)).toBe(401);
    expect(h.minted).toHaveLength(0);
  });

  it('identity refuses a cookie the hub no longer honours, and answers for a bearer token', async () => {
    hubToken(40 * DAY_MS);

    expect(await identity()).toBe(401);
    expect(await identity('hub-token')).toBe(200);
  });
});

describe("re-signing the hub's own session cookie", () => {
  it('re-tracks the re-signed session', async () => {
    hubToken(2 * DAY_MS);

    await visit({ navigate: true });

    expect(tracked('hub-jti')).toBe(true);
  });

  it("keeps the account fresh in this browser's account list", async () => {
    hubToken(2 * DAY_MS);
    const accounts = `${REDIS_SYS_KEYS.DEVICE.ACCOUNTS}:dev-d`;
    const old = String(Date.now() - 20 * DAY_MS);
    await h.sys.hSet(accounts, '100', old);
    await h.sys.hSet(accounts, '200', old);

    await visit({ navigate: true });

    expect(Number(h.sys.hashes.get(accounts)?.get('100'))).toBeGreaterThan(Number(old));
    expect(h.sys.hashes.get(accounts)?.get('200')).toBe(old);
  });

  it("leaves a banned or deleted account's cookie alone", async () => {
    hubToken(2 * DAY_MS);
    h.users.set(100, { id: 100, bannedAt: new Date() });
    await visit({ navigate: true });
    h.users.set(100, { id: 100, deletedAt: new Date() });
    await visit({ navigate: true });

    expect(h.minted).toHaveLength(0);
  });

  it('re-signs it under the same jti and sign-in time on a page navigation past the update age', async () => {
    hubToken(2 * DAY_MS);

    const { set } = await visit({ navigate: true });

    expect(h.minted).toHaveLength(1);
    expect(h.minted[0].jti).toBe('hub-jti');
    expect(h.minted[0].payload).toMatchObject({ sub: '100', sid: 'fam-a' });
    expect(h.minted[0].payload.iat0).toBe(h.tokens.get('hub-token')!.iat0);
    expect(set).toHaveBeenCalledWith(SESSION_COOKIE, 'rolled-token', expect.anything());
  });

  it('leaves a token younger than the update age, and non-navigation requests, alone', async () => {
    hubToken(60 * 60 * 1000);
    await visit({ navigate: true });
    hubToken(2 * DAY_MS);
    await visit();

    expect(h.minted).toHaveLength(0);
  });

  it("leaves the shared moderation account's cookie alone", async () => {
    process.env.CIVITAI_MODERATION_USER_ID = '100';
    hubToken(2 * DAY_MS);

    await visit({ navigate: true });

    expect(h.minted).toHaveLength(0);
  });

  it('leaves an impersonation session alone', async () => {
    hubToken(2 * DAY_MS, { impersonatedBy: 7 });

    await visit({ navigate: true });

    expect(h.minted).toHaveLength(0);
  });
});
