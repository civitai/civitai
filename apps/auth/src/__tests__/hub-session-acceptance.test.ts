import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSysRedis, type SysRedisFake } from '../test/sys-redis.fake';

// The hub honours its own session cookie while the family was used within 30 days, or the token was signed
// within 30 days, and re-signs it on a page navigation once it is older than the update age. Runs the real
// hooks and liveness records over an in-memory sys redis.

const h = vi.hoisted(() => ({
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
vi.mock('$lib/server/axiom', () => ({ logAxiomError: vi.fn(), logToAxiom: vi.fn() }));
vi.mock('$lib/server/db/db', () => ({ db: {} }));
vi.mock('$lib/server/auth/session-producer', () => ({
  getOrProduceSessionUser: async (id: number) => ({ id }),
}));
vi.mock('$lib/server/auth/verifier', () => ({
  verifier: { verifyToken: async (token: string) => h.tokens.get(token) ?? null },
  signatureVerifier: { verifyToken: async (token: string) => h.tokens.get(token) ?? null },
}));

import type * as CivitaiAuth from '@civitai/auth';
import { REDIS_SYS_KEYS } from '@civitai/redis';
import { handle } from '../hooks.server';
import { SESSION_COOKIE } from '$lib/server/auth/session';

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
      get: (name: string) => (name === SESSION_COOKIE ? 'hub-token' : undefined),
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

beforeEach(() => {
  h.sys ??= makeSysRedis();
  h.sys.reset();
  h.tokens.clear();
  h.minted = [];
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

describe("re-signing the hub's own session cookie", () => {
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

  it('leaves an impersonation session alone', async () => {
    hubToken(2 * DAY_MS, { impersonatedBy: 7 });

    await visit({ navigate: true });

    expect(h.minted).toHaveLength(0);
  });
});
