import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { deviceCookieName } from '@civitai/auth';
import type * as DeviceModule from '$lib/server/auth/device';
import type * as SessionModule from '$lib/server/auth/session';

// Service callers reach the session routes in two shapes: the session as the credential (a forwarded cookie, or
// the token as the Bearer on refresh), or the caller's own credential as the Bearer with the session in the
// body. Both must work, and `auth_s2s_requests_total` must tell them apart. Runs the real hooks + route
// handlers; only token verification, minting and the redis-backed stores are stubbed.

const INTERNAL = 'internal-secret';
const TOKEN = 'session-token';
const DEVICE = 'device-1';
const USER = 100;
const TARGET = 200;

const h = vi.hoisted(() => {
  process.env.AUTH_INTERNAL_TOKEN = 'internal-secret';
  return {
    verifyToken: vi.fn(),
    invalidateToken: vi.fn(async () => undefined),
    listAccounts: vi.fn(),
    isLinkedAndFresh: vi.fn(async () => true),
  };
});

vi.mock('$lib/server/axiom', () => ({ logAxiomError: vi.fn(), logToAxiom: vi.fn() }));
vi.mock('$lib/server/auth/verifier', () => ({ verifier: { verifyToken: h.verifyToken } }));
vi.mock('$lib/server/auth/registry', () => ({
  sessions: { trackToken: vi.fn(async () => undefined), invalidateToken: h.invalidateToken },
}));
vi.mock('$lib/server/auth/session-producer', () => ({
  getOrProduceSessionUser: vi.fn(async (id: number) => ({ id, username: `u${id}` })),
}));
vi.mock('$lib/server/oauth/first-party', () => ({
  buildPostLoginOriginCheck: async () => () => false,
}));
vi.mock('$lib/server/auth/device', async (importOriginal) => ({
  ...(await importOriginal<typeof DeviceModule>()),
  listAccounts: h.listAccounts,
  isLinkedAndFresh: h.isLinkedAndFresh,
  touchAccount: vi.fn(async () => undefined),
}));
vi.mock('$lib/server/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionModule>()),
  getSigner: () => ({ mintSessionToken: async () => 'fresh-token' }),
  mintUserSession: async () => 'minted-token',
  setSessionCookie: vi.fn(),
  clearSession: vi.fn(),
}));

import { handle } from '../hooks.server';
import { register } from '$lib/server/metrics';
import { SESSION_COOKIE } from '$lib/server/auth/session';
import * as refresh from '../routes/api/auth/refresh/+server';
import * as accounts from '../routes/api/auth/accounts/+server';
import * as switchRoute from '../routes/api/auth/switch/+server';
import * as logout from '../routes/logout/+server';
import * as ping from '../routes/api/auth/internal-ping/+server';

const HUB = 'https://auth.civitai.com';
// Each route's handler is typed to its own route id; the harness hands it a plain event.
type Handler = (event: never) => Response | Promise<Response>;

async function call(
  routeId: string,
  handler: Handler,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    cookies?: Record<string, string>;
  }
) {
  const url = new URL(`${HUB}${routeId}`);
  const request = new Request(url, {
    method: opts.method ?? 'POST',
    headers: opts.headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const jar = opts.cookies ?? {};
  const event = {
    url,
    route: { id: routeId },
    request,
    cookies: { get: (name: string) => jar[name], set: vi.fn(), delete: vi.fn() },
    locals: {},
  };
  const resolve = async (e: RequestEvent) => {
    try {
      return await handler(e as never);
    } catch (err) {
      // SvelteKit turns a thrown error()/redirect() into a response; do the same here.
      return new Response(null, { status: (err as { status?: number }).status ?? 500 });
    }
  };
  return handle({ event, resolve } as never) as Promise<Response>;
}

async function s2sCount(route: string, shape: string, result: string): Promise<number> {
  const metric = (await register.getMetricsAsJSON()).find(
    (m) => m.name === 'auth_s2s_requests_total'
  );
  const hit = metric?.values.find(
    (v) => v.labels.route === route && v.labels.shape === shape && v.labels.result === result
  );
  return hit?.value ?? 0;
}

const internal = { authorization: `Bearer ${INTERNAL}`, 'content-type': 'application/json' };
const sessionCookies = { [SESSION_COOKIE]: TOKEN, [deviceCookieName()]: DEVICE };

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyToken.mockImplementation(async (t: string) => {
    if (t !== TOKEN) throw new Error('bad token');
    return { sub: String(USER), jti: 'jti-1' };
  });
  h.listAccounts.mockImplementation(async (deviceId: string) =>
    deviceId === DEVICE ? [{ userId: USER, lastSwitchedAt: 1 }] : []
  );
});

describe('refresh', () => {
  it('returns 200 for the token as the Bearer and for the session in the body, counted apart', async () => {
    const before = {
      bearer: await s2sCount('/api/auth/refresh', 'bearer', '200'),
      internal: await s2sCount('/api/auth/refresh', 'internal', '200'),
    };

    const old = await call('/api/auth/refresh', refresh.POST, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(old.status).toBe(200);
    const next = await call('/api/auth/refresh', refresh.POST, {
      headers: internal,
      body: { token: TOKEN, deviceId: DEVICE },
    });
    expect(next.status).toBe(200);
    expect(await next.json()).toEqual({ token: 'fresh-token' });

    expect(await s2sCount('/api/auth/refresh', 'bearer', '200')).toBe(before.bearer + 1);
    expect(await s2sCount('/api/auth/refresh', 'internal', '200')).toBe(before.internal + 1);
  });

  it('refuses a session in the body without the right caller credential (control)', async () => {
    const res = await call('/api/auth/refresh', refresh.POST, {
      headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
      body: { token: TOKEN },
    });
    expect(res.status).toBe(401);
  });
});

describe('accounts', () => {
  it('lists the same accounts for a forwarded cookie and for the session in the body', async () => {
    const before = {
      cookie: await s2sCount('/api/auth/accounts', 'cookie', '200'),
      internal: await s2sCount('/api/auth/accounts', 'internal', '200'),
    };

    const old = await call('/api/auth/accounts', accounts.GET, {
      method: 'GET',
      cookies: sessionCookies,
    });
    const next = await call('/api/auth/accounts', accounts.POST, {
      headers: internal,
      body: { token: TOKEN, deviceId: DEVICE },
    });

    expect(old.status).toBe(200);
    expect(next.status).toBe(200);
    const listed = (await old.json()) as { accounts: unknown[] };
    expect(listed.accounts).toHaveLength(1);
    expect(await next.json()).toEqual(listed);

    expect(await s2sCount('/api/auth/accounts', 'cookie', '200')).toBe(before.cookie + 1);
    expect(await s2sCount('/api/auth/accounts', 'internal', '200')).toBe(before.internal + 1);
  });

  it('ignores the session in the body without the right caller credential (control)', async () => {
    const res = await call('/api/auth/accounts', accounts.POST, {
      headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
      body: { token: TOKEN, deviceId: DEVICE },
    });
    expect(await res.json()).toEqual({ accounts: [] });
  });
});

describe('switch', () => {
  it('switches for a forwarded cookie and for the session in the body', async () => {
    const old = await call('/api/auth/switch', switchRoute.POST, {
      headers: { 'content-type': 'application/json' },
      body: { userId: TARGET },
      cookies: sessionCookies,
    });
    const next = await call('/api/auth/switch', switchRoute.POST, {
      headers: internal,
      body: { token: TOKEN, deviceId: DEVICE, userId: TARGET },
    });
    expect(old.status).toBe(200);
    expect(next.status).toBe(200);
    expect(await next.json()).toEqual({ token: 'minted-token', userId: TARGET });
    expect(h.isLinkedAndFresh).toHaveBeenCalledWith(DEVICE, TARGET);
  });
});

describe('logout revoke', () => {
  it('revokes the session named in the body', async () => {
    const res = await call('/logout', logout.POST, { headers: internal, body: { token: TOKEN } });
    expect(res.status).toBe(302);
    expect(h.invalidateToken).toHaveBeenCalledWith('jti-1', USER);
  });

  it('revokes nothing for a body without the right caller credential (control)', async () => {
    await call('/logout', logout.POST, {
      headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
      body: { token: TOKEN },
    });
    expect(h.invalidateToken).not.toHaveBeenCalled();
  });
});

describe('internal-ping', () => {
  const pingWith = (authorization?: string) =>
    ping.GET({
      request: new Request(`${HUB}/api/auth/internal-ping`, {
        headers: authorization ? { authorization } : {},
      }),
    } as never) as Response;

  it('answers 204 to the configured caller credential and 401 otherwise', () => {
    expect(pingWith(`Bearer ${INTERNAL}`).status).toBe(204);
    expect(pingWith('Bearer wrong').status).toBe(401);
    expect(pingWith().status).toBe(401);
  });
});
