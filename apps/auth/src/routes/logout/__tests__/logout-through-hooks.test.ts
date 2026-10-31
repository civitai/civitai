import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { makeSysRedis, type SysRedisFake } from '../../../test/sys-redis.fake';

// A site's sign-out reaches the hub server-to-server with its token and the browser's device id in the body.
// Run through the real hooks, the hub signs out every session on that browser, including when the caller's own
// session was already signed out by an earlier leg of the same logout.

const h = vi.hoisted(() => {
  process.env.AUTH_INTERNAL_TOKEN = 'internal-secret';
  process.env.AUTH_JWT_ISSUER = 'https://auth.civitai.com';
  return {
    sys: undefined as unknown as SysRedisFake,
    tokens: new Map<string, Record<string, unknown>>(),
  };
});

vi.mock('$lib/server/redis', () => ({
  getSysRedis: () => h.sys,
  getRedis: () => null,
  evalSys: (script: string, keys: string[], args: string[]) =>
    h.sys.eval(script, { keys, arguments: args }),
}));
vi.mock('$lib/server/axiom', () => ({ logAxiomError: vi.fn(), logToAxiom: vi.fn() }));
vi.mock('$lib/server/oauth/first-party', () => ({
  buildPostLoginOriginCheck: async () => () => true,
}));
vi.mock('$lib/server/db/db', () => ({ db: {} }));
vi.mock('$lib/server/auth/session-producer', () => ({
  getOrProduceSessionUser: async (id: number) => ({ id }),
}));
vi.mock('$lib/server/auth/verifier', () => ({
  verifier: {
    verifyToken: async (token: string) => {
      const claims = h.tokens.get(token);
      const { sessions } = await import('$lib/server/auth/registry');
      return claims && !(await sessions.isRevoked(claims)) ? claims : null;
    },
  },
  signatureVerifier: { verifyToken: async (token: string) => h.tokens.get(token) ?? null },
}));

import { REDIS_SYS_KEYS } from '@civitai/redis';
import { handle } from '../../../hooks.server';
import { POST } from '../+server';
import { sessions } from '$lib/server/auth/registry';

const DEVICE = 'device-1';
const familiesKey = `${REDIS_SYS_KEYS.SESSION.DEVICE_FAMILIES}:${DEVICE}`;
const accountsKey = `${REDIS_SYS_KEYS.DEVICE.ACCOUNTS}:${DEVICE}`;

async function siteLogout(body: Record<string, unknown>) {
  const url = new URL('https://auth.civitai.com/logout');
  const event = {
    url,
    route: { id: '/logout' },
    request: new Request(url, {
      method: 'POST',
      headers: { authorization: 'Bearer internal-secret', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    cookies: { get: () => undefined, set: vi.fn(), delete: vi.fn() },
    locals: {},
  };
  const resolve = async (e: RequestEvent) => {
    try {
      return await POST(e as never);
    } catch (err) {
      return new Response(null, { status: (err as { status?: number }).status ?? 500 });
    }
  };
  return handle({ event, resolve } as never) as Promise<Response>;
}

const revoked = (claims: { jti: string; sid?: string }) =>
  sessions.isRevoked({ ...claims, signedAt: Date.now() });

beforeEach(async () => {
  h.sys ??= makeSysRedis();
  h.sys.reset();
  h.tokens.clear();
  h.tokens.set('site-token', {
    sub: '100',
    jti: 'site-jti',
    sid: 'family-a',
    signedAt: Date.now(),
  });
  await h.sys.sAdd(familiesKey, ['family-a', 'family-b']);
  await h.sys.hSet(accountsKey, '100', '1');
});

describe('a site signing out through the hub', () => {
  it('signs out every session on the browser named in the body', async () => {
    expect((await siteLogout({ token: 'site-token', deviceId: DEVICE })).status).toBe(302);

    expect(await revoked({ jti: 'x', sid: 'family-b' })).toBe(true);
    expect(h.sys.hashes.has(accountsKey)).toBe(false);
  });

  it("still does when the caller's session was already signed out", async () => {
    await sessions.invalidateFamily('family-a');

    await siteLogout({ token: 'site-token', deviceId: DEVICE });

    expect(await revoked({ jti: 'x', sid: 'family-b' })).toBe(true);
    expect(h.sys.hashes.has(accountsKey)).toBe(false);
  });
});
