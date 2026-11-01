import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSysRedis, type SysRedisFake } from '../test/sys-redis.fake';

// The hub's move from the shared cookie slot to its host-only slot: the copy /authorize makes while the hub still
// reads the shared slot first, and the move of a browser that arrives later with only a shared-slot token. Runs
// the real hooks, /authorize, session registry and lineage records over an in-memory sys redis.

const h = vi.hoisted(() => {
  process.env.AUTH_JWT_ISSUER = 'https://auth.civitai.com';
  process.env.AUTH_INTERNAL_TOKEN = 'internal-secret';
  return {
    sys: undefined as unknown as SysRedisFake,
    tokens: new Map<string, Record<string, unknown>>(),
    users: new Map<number, Record<string, unknown>>(),
  };
});

vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiAuth>()),
  maybeCreateSessionSigner: () => ({
    maxAge: 3600,
    mintSessionToken: async (payload: Record<string, unknown>, opts: { jti: string }) => {
      const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const token = `${part({ alg: 'none' })}.${part({ ...payload, jti: opts.jti })}.sig`;
      h.tokens.set(token, { ...payload, jti: opts.jti });
      return token;
    },
  }),
}));
vi.mock('$lib/server/redis', () => ({
  getSysRedis: () => h.sys,
  getRedis: () => null,
  evalSys: (script: string, keys: string[], args: string[]) =>
    h.sys.eval(script, { keys, arguments: args }),
}));
vi.mock('$lib/server/auth/verifier', async () => {
  const { sessions } = await import('$lib/server/auth/registry');
  const known = async (token: string) => h.tokens.get(token) ?? null;
  return {
    signatureVerifier: { verifyToken: known },
    verifier: {
      verifyToken: async (token: string) => {
        const claims = await known(token);
        return claims && !(await sessions.isRevoked(claims as never)) ? claims : null;
      },
    },
  };
});
vi.mock('$lib/server/axiom', () => ({
  logAxiomError: vi.fn(),
  logToAxiom: vi.fn(async () => undefined),
}));
vi.mock('$lib/server/db/db', () => ({ db: {} }));
vi.mock('$lib/server/auth/session-producer', () => ({
  getOrProduceSessionUser: async (id: number) => h.users.get(id) ?? { id },
}));
vi.mock('$lib/server/auth/pending-authz', () => ({
  resolveAuthorizingUser: async ({ sessionUser }: { sessionUser: unknown }) => sessionUser,
  issuePendingAuthz: async () => false,
}));
vi.mock('$lib/server/oauth/rate-limit', () => ({ checkOAuthRateLimit: async () => true }));
vi.mock('$lib/server/oauth/audit-log', () => ({ logOAuthEvent: vi.fn() }));
vi.mock('$lib/server/oauth/oidc-nonce', () => ({ storeOidcContext: async () => undefined }));
vi.mock('$lib/server/oauth/access', () => ({ checkClientAccess: async () => ({ allowed: true }) }));
vi.mock('$lib/server/oauth/server', () => ({
  oauthServer: { authorize: async () => ({ authorizationCode: 'code-1' }) },
}));
vi.mock('$lib/server/oauth/model', () => ({
  authorizeRedirectUriStore: { run: (_: string, fn: () => unknown) => fn() },
  resolveClientLite: async () => ({
    isFirstParty: true,
    skipConsent: true,
    redirectUris: [CALLBACK],
    accessMode: 'public',
  }),
}));

import type * as CivitaiAuth from '@civitai/auth';
import { deviceCookieNameForSlot, sessionCookieNameForSlot, type SessionUser } from '@civitai/auth';
import { REDIS_SYS_KEYS } from '@civitai/redis';
import { handle } from '../hooks.server';
import { GET as authorizeGet } from '../routes/api/auth/oauth/authorize/+server';
import { POST as switchPost } from '../routes/api/auth/switch/+server';
import { GET as accountsGet } from '../routes/api/auth/accounts/+server';
import { establishSession } from '$lib/server/auth/session';

const CALLBACK = 'https://civitai.com/api/auth/callback';
const DAY_MS = 24 * 60 * 60 * 1000;
const SHARED = () => sessionCookieNameForSlot('shared');
const HOST = () => sessionCookieNameForSlot('host');
const SHARED_DEVICE = () => deviceCookieNameForSlot('shared');
const HOST_DEVICE = () => deviceCookieNameForSlot('host');

type Jar = ReturnType<typeof jar>;
function jar(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial));
  const sets: { name: string; value: string; opts: Record<string, unknown> }[] = [];
  return {
    values,
    sets,
    get: (name: string) => values.get(name),
    getAll: () => [...values].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string, opts: Record<string, unknown>) => {
      values.set(name, value);
      sets.push({ name, value, opts });
    },
    delete: (name: string) => {
      values.delete(name);
    },
  };
}

async function visit(
  cookies: Jar,
  opts: {
    path?: string;
    routeId?: string;
    init?: RequestInit;
    /** A server-to-server caller: no Origin or Referer. */
    server?: boolean;
    run?: (event: never) => Promise<Response>;
  } = {}
) {
  const path = opts.path ?? '/login';
  const url = new URL(`https://auth.civitai.com${path}`);
  const headers = new Headers(opts.init?.headers);
  if (!opts.server && !headers.has('referer')) headers.set('referer', 'https://auth.civitai.com/');
  const event = {
    url,
    route: { id: opts.routeId ?? '/login' },
    request: new Request(url, { ...opts.init, headers }),
    cookies,
    locals: {} as Record<string, unknown>,
    getClientAddress: () => '127.0.0.1',
  };
  const resolve = async (ev: never) => {
    if (!opts.run) return new Response('ok');
    try {
      return await opts.run(ev);
    } catch (e) {
      const thrown = e as { status?: number; location?: string };
      if (thrown.status) return new Response(null, { status: thrown.status });
      throw e;
    }
  };
  const response = await handle({ event, resolve } as never);
  return Object.assign(event.locals as { session?: Record<string, unknown>; deviceId?: string }, {
    response,
  });
}

const authorize = (cookies: Jar) =>
  visit(cookies, {
    path:
      `/api/auth/oauth/authorize?client_id=spoke&redirect_uri=${encodeURIComponent(CALLBACK)}` +
      '&code_challenge=x&code_challenge_method=S256&state=s&scope=1',
    routeId: '/api/auth/oauth/authorize',
    run: (event) => authorizeGet(event) as Promise<Response>,
  });

const J0 = 'j0-token';
function sharedSession(extra: Record<string, unknown> = {}) {
  h.tokens.set(J0, {
    sub: '100',
    jti: 'j0',
    iat0: Date.now() - 5 * DAY_MS,
    signedAt: Date.now() - 60 * 60 * 1000,
    ...extra,
  });
}
const claimsOf = (token: string | undefined) => (token ? h.tokens.get(token) : undefined);
const upgradeKey = (base: string) =>
  `${base}:${createHash('sha256').update('j0').digest('base64url')}`;
const mintedJtis = () =>
  new Set([...h.tokens.values()].map((c) => c.jti).filter((jti) => jti !== 'j0'));

const setMode = (mode: 'shared' | 'host') => (process.env.AUTH_SESSION_COOKIE_MODE = mode);

beforeEach(() => {
  h.sys ??= makeSysRedis();
  h.sys.reset();
  h.tokens.clear();
  h.users.clear();
  setMode('shared');
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.AUTH_SESSION_COOKIE_MODE;
  delete process.env.CIVITAI_MODERATION_USER_ID;
  delete process.env.AUTH_RETIRE_SHARED_SESSION;
  delete process.env.AUTH_LEGACY_READ;
});

const TOKEN_STATE = REDIS_SYS_KEYS.SESSION.TOKEN_STATE;
const accountsOf = (deviceId: string) => `${REDIS_SYS_KEYS.DEVICE.ACCOUNTS}:${deviceId}`;
const asUser = (id: number) => ({ id } as SessionUser);

// Accounts the hub must not give a new cookie to, as the session producer would return them.
const refusedAccounts = [
  ['banned', () => h.users.set(100, { id: 100, bannedAt: new Date() })],
  ['deleted', () => h.users.set(100, { id: 100, deletedAt: new Date() })],
  ['the moderation account', () => (process.env.CIVITAI_MODERATION_USER_ID = '100')],
] as const;

describe('/authorize copying the hub session into the host-only slot', () => {
  it('keeps the hub signed in, on the same device id, after the shared-slot session lapses', async () => {
    sharedSession();
    const cookies = jar({ [SHARED()]: J0, [SHARED_DEVICE()]: 'dev-d' });

    await authorize(cookies);

    const copy = claimsOf(cookies.get(HOST()));
    expect(copy).toMatchObject({ sub: '100', sid: 'j0', iat0: h.tokens.get(J0)!.iat0 });
    expect(copy!.jti).not.toBe('j0');
    expect(cookies.sets.find((s) => s.name === HOST())?.opts.domain).toBeUndefined();
    expect(cookies.get(HOST_DEVICE())).toBe('dev-d');
    expect(cookies.sets.find((s) => s.name === HOST_DEVICE())?.opts.domain).toBeUndefined();

    cookies.values.delete(SHARED());
    cookies.values.delete(SHARED_DEVICE());
    setMode('host');
    const later = await visit(cookies);

    expect(later.session?.sub).toBe('100');
    expect(later.deviceId).toBe('dev-d');
  });

  it('does not copy an impersonation session', async () => {
    sharedSession({ impersonatedBy: 7 });
    const cookies = jar({ [SHARED()]: J0 });

    await authorize(cookies);

    expect(cookies.get(HOST())).toBeUndefined();
  });

  it.each(refusedAccounts)(
    'does not copy the session of an account that is %s',
    async (_, refuse) => {
      sharedSession();
      refuse();
      const cookies = jar({ [SHARED()]: J0 });

      await authorize(cookies);

      expect(cookies.sets.some((s) => s.name === HOST())).toBe(false);
    }
  );

  it('a device id a shared-mode sign-in moved to is the one host mode reads', async () => {
    sharedSession();
    const cookies = jar({ [SHARED()]: J0, [SHARED_DEVICE()]: 'dev-d' });
    await authorize(cookies);
    cookies.values.delete(SHARED());
    cookies.values.delete(HOST());
    await h.sys.hSet(accountsOf('dev-d'), '100', String(Date.now()));
    await h.sys.hSet(accountsOf('dev-d'), '200', String(Date.now()));

    await establishSession(cookies as never, asUser(300));
    const moved = cookies.get(SHARED_DEVICE());
    cookies.values.delete(SHARED());
    setMode('host');

    expect(moved).not.toBe('dev-d');
    expect(cookies.get(HOST_DEVICE())).toBe(moved);
    expect((await visit(cookies)).deviceId).toBe(moved);
  });

  it('keeps a host-only copy that is already this session', async () => {
    sharedSession();
    const cookies = jar({ [SHARED()]: J0 });
    await authorize(cookies);
    const first = cookies.get(HOST());

    await authorize(cookies);

    expect(cookies.get(HOST())).toBe(first);
  });
});

describe('host mode: a browser arriving with only a shared-slot hub token', () => {
  beforeEach(() => {
    setMode('host');
    process.env.AUTH_RETIRE_SHARED_SESSION = 'true';
  });

  it('is moved to a host-only session of the same family, and the shared-slot token ends', async () => {
    sharedSession();
    const cookies = jar({ [SHARED()]: J0, [SHARED_DEVICE()]: 'dev-d' });

    const locals = await visit(cookies);

    expect(locals.session).toMatchObject({ sub: '100', sid: 'j0' });
    expect(cookies.get(HOST())).toBeDefined();
    expect(cookies.get(SHARED())).toBeUndefined();
    expect(cookies.get(HOST_DEVICE())).toBe('dev-d');
    expect(await visit(jar({ [SHARED()]: J0 })).then((l) => l.session?.jti)).toBe(
      locals.session?.jti
    );
  });

  it('two tabs racing on the same token get one session', async () => {
    sharedSession();
    const a = jar({ [SHARED()]: J0 });
    const b = jar({ [SHARED()]: J0 });

    const [la, lb] = await Promise.all([visit(a), visit(b)]);

    expect(mintedJtis().size).toBe(1);
    expect(la.session?.jti).toBe(lb.session?.jti);
  });

  it('a tab arriving after the token ended is signed in with the same session, within 60 seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    sharedSession();
    const first = await visit(jar({ [SHARED()]: J0 }));

    vi.setSystemTime(Date.now() + 59_000);
    const late = await visit(jar({ [SHARED()]: J0 }));

    expect(late.session?.jti).toBe(first.session?.jti);
  });

  it('a replay of the ended token 61 seconds later gets no session, even after a late tab', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const ended = Date.now();
    sharedSession();
    await visit(jar({ [SHARED()]: J0 }));
    vi.setSystemTime(ended + 30_000);
    await visit(jar({ [SHARED()]: J0 }));

    vi.setSystemTime(ended + 61_000);
    const replay = await visit(jar({ [SHARED()]: J0 }));

    expect(replay.session).toBeUndefined();
  });

  it('a request behind a winner that died holding the lock signs in once the lock lapses', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    sharedSession();
    await h.sys.eval(`redis.call('SET', KEYS[1], '1', 'NX', 'EX', '5') return 1`, {
      keys: [upgradeKey(REDIS_SYS_KEYS.SESSION.HUB_UPGRADE_LOCK)],
      arguments: [],
    });

    const pending = visit(jar({ [SHARED()]: J0 }));
    await new Promise((r) => setTimeout(r, 700));
    vi.setSystemTime(Date.now() + 5_000);
    const locals = await pending;

    expect(locals.session?.sub).toBe('100');
    expect(mintedJtis().size).toBe(1);
  });

  it('an impersonation session is served from the shared slot, not moved and not ended', async () => {
    sharedSession({ impersonatedBy: 7 });
    const cookies = jar({ [SHARED()]: J0 });

    const locals = await visit(cookies);

    expect(locals.session?.impersonatedBy).toBe(7);
    expect(cookies.sets.some((s) => s.name === HOST())).toBe(false);
    expect(h.sys.hashes.get(TOKEN_STATE)?.has('j0')).toBeFalsy();
  });

  it.each(refusedAccounts)(
    'the session of an account that is %s is not moved',
    async (_, refuse) => {
      sharedSession();
      refuse();
      const cookies = jar({ [SHARED()]: J0 });

      await visit(cookies);

      expect(cookies.sets.some((s) => s.name === HOST())).toBe(false);
      expect(h.sys.hashes.get(TOKEN_STATE)?.has('j0')).toBeFalsy();
    }
  );

  it('carries the shared-slot device id over a different host-only one', async () => {
    sharedSession();
    const cookies = jar({ [SHARED()]: J0, [SHARED_DEVICE()]: 'dev-new', [HOST_DEVICE()]: 'dev-d' });

    const locals = await visit(cookies);

    expect(locals.deviceId).toBe('dev-new');
    expect(cookies.get(HOST_DEVICE())).toBe('dev-new');
  });

  it('a host-only copy of the same session ends the shared-slot token', async () => {
    setMode('shared');
    sharedSession();
    const cookies = jar({ [SHARED()]: J0, [SHARED_DEVICE()]: 'dev-d' });
    await authorize(cookies);
    setMode('host');

    const locals = await visit(cookies);

    expect(locals.session?.sub).toBe('100');
    expect(locals.session?.jti).not.toBe('j0');
    expect(h.sys.hashes.get(TOKEN_STATE)?.get('j0')).toBeTruthy();
    expect((await visit(jar({ [SHARED()]: J0 }))).session).toBeUndefined();
  });

  it('a host-only session the hub no longer honours gives way to a live shared-slot one', async () => {
    sharedSession();
    h.tokens.set('host-idle', {
      sub: '100',
      jti: 'hi',
      sid: 'fam-old',
      signedAt: Date.now() - 40 * DAY_MS,
    });
    const cookies = jar({ [HOST()]: 'host-idle', [SHARED()]: J0 });

    const locals = await visit(cookies);

    expect(locals.session).toMatchObject({ sub: '100', sid: 'j0' });
    expect(cookies.get(HOST())).not.toBe('host-idle');
    expect(cookies.get(SHARED())).toBeUndefined();
  });

  it("keeps a host-only session, whoever's it is, over a live shared-slot one", async () => {
    sharedSession({ sub: '200' });
    h.tokens.set('host-a', { sub: '100', jti: 'ha', sid: 'fam-a', signedAt: Date.now() });
    const cookies = jar({ [HOST()]: 'host-a', [SHARED()]: J0, [SHARED_DEVICE()]: 'dev-d' });

    const locals = await visit(cookies);

    expect(locals.session?.sub).toBe('100');
    expect(mintedJtis()).toEqual(new Set(['ha']));
    expect(cookies.get(SHARED())).toBeUndefined();
    expect(cookies.get(SHARED_DEVICE())).toBeUndefined();
    expect(h.sys.hashes.get(REDIS_SYS_KEYS.SESSION.TOKEN_STATE)?.has('j0')).toBeFalsy();
  });

  it('with the shared slot no longer read, a shared-slot token is neither honoured nor moved', async () => {
    process.env.AUTH_LEGACY_READ = 'false';
    sharedSession();
    const cookies = jar({ [SHARED()]: J0 });

    const locals = await visit(cookies);

    expect(locals.session).toBeUndefined();
    expect(mintedJtis().size).toBe(0);
    expect(cookies.get(HOST())).toBeUndefined();
  });

  it('a signed-out shared-slot token is not moved', async () => {
    sharedSession();
    await h.sys.hSet(REDIS_SYS_KEYS.SESSION.TOKEN_STATE, 'j0', 'invalid');
    const cookies = jar({ [SHARED()]: J0 });

    expect((await visit(cookies)).session).toBeUndefined();
    expect(cookies.get(HOST())).toBeUndefined();
  });
});

describe('host mode before the shared-slot session is retired', () => {
  beforeEach(() => setMode('host'));

  it('copies the shared-slot session but neither ends it nor expires its cookies', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    sharedSession();
    const cookies = jar({ [SHARED()]: J0, [SHARED_DEVICE()]: 'dev-d' });

    const first = await visit(cookies);
    vi.setSystemTime(Date.now() + 61_000);
    const later = await visit(cookies);

    expect(first.session).toMatchObject({ sub: '100', sid: 'j0' });
    expect(cookies.get(HOST())).toBeDefined();
    expect(later.session?.jti).toBe(first.session?.jti);
    expect(cookies.get(SHARED())).toBe(J0);
    expect(cookies.get(SHARED_DEVICE())).toBe('dev-d');
    expect(h.sys.hashes.get(TOKEN_STATE)?.has('j0')).toBeFalsy();
    expect((await visit(jar({ [SHARED()]: J0 }))).session?.sub).toBe('100');
  });
});

describe('a server-to-server caller in host mode before the shared-slot session is retired', () => {
  beforeEach(() => setMode('host'));
  const timeline = [0, 30_000, 61_000, 122_000, 183_000];

  it('is served from the shared-slot session and never given a host-only one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    sharedSession();

    const sessions = [];
    for (const at of timeline) {
      vi.setSystemTime(start + at);
      sessions.push((await visit(jar({ [SHARED()]: J0 }), { server: true })).session?.jti);
    }

    expect(mintedJtis().size).toBe(0);
    expect(sessions).toEqual(timeline.map(() => 'j0'));
  });

  it('a browser on the same timeline is moved once and keeps that session', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    sharedSession();
    const cookies = jar({ [SHARED()]: J0 });

    const sessions = [];
    for (const at of timeline) {
      vi.setSystemTime(start + at);
      sessions.push((await visit(cookies)).session?.jti);
    }

    expect(mintedJtis().size).toBe(1);
    expect(new Set(sessions)).toEqual(mintedJtis());
  });
});

describe('a navigation re-sign in shared mode after /authorize made a host-only copy', () => {
  it('keeps the copy, so the next /authorize mints nothing new', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    sharedSession();
    const cookies = jar({ [SHARED()]: J0 });
    await authorize(cookies);
    const copy = cookies.get(HOST());
    vi.setSystemTime(Date.now() + 2 * DAY_MS);

    await visit(cookies, { init: { headers: { 'sec-fetch-mode': 'navigate' } } });
    expect(cookies.get(SHARED())).not.toBe(J0);
    await authorize(cookies);

    expect(cookies.get(HOST())).toBe(copy);
    expect(mintedJtis().size).toBe(1);
  });
});

describe('a new sign-in of the same account in shared mode after its copied session ended', () => {
  it('drops the copy of the ended session', async () => {
    sharedSession();
    const cookies = jar({ [SHARED()]: J0 });
    await authorize(cookies);
    await h.sys.hSet(REDIS_SYS_KEYS.SESSION.FAMILY_STATE, 'j0', 'invalid');
    cookies.values.delete(SHARED());

    await establishSession(cookies as never, asUser(100));

    expect(cookies.get(HOST())).toBeUndefined();
  });
});

describe('an account change in shared mode after /authorize made a host-only copy', () => {
  it('drops the copy, so the hub keeps the new account once it reads host-only first', async () => {
    sharedSession();
    const cookies = jar({ [SHARED()]: J0, [SHARED_DEVICE()]: 'dev-d' });
    await authorize(cookies);
    await h.sys.hSet(accountsOf('dev-d'), '100', String(Date.now()));
    await h.sys.hSet(accountsOf('dev-d'), '200', String(Date.now()));

    const switched = await visit(cookies, {
      path: '/api/auth/switch',
      routeId: '/api/auth/switch',
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 200 }),
      },
      run: (event) => switchPost(event) as Promise<Response>,
    });
    setMode('host');
    const after = await visit(cookies);

    expect(switched.response.status).toBe(200);
    expect(after.session?.sub).toBe('200');
    expect(after.deviceId).toBe('dev-d');
  });
});

describe('re-signing the hub session under the slot it was read from', () => {
  it('a host-only session is re-signed there in shared mode', async () => {
    h.tokens.set('host-token', {
      sub: '100',
      jti: 'hj',
      sid: 'f',
      signedAt: Date.now() - 2 * DAY_MS,
    });
    const cookies = jar({ [HOST()]: 'host-token' });
    const url = new URL('https://auth.civitai.com/login');
    const event = {
      url,
      route: { id: '/login' },
      request: new Request(url, { headers: { 'sec-fetch-mode': 'navigate' } }),
      cookies,
      locals: {},
    };

    await handle({ event, resolve: async () => new Response('ok') } as never);

    expect(cookies.sets.map((s) => s.name)).toEqual([HOST()]);
  });
});

describe('a sign-in on a browser carrying a device id from a signed-out account list', () => {
  const accounts = `${REDIS_SYS_KEYS.DEVICE.ACCOUNTS}:dev-d`;

  it.each(['shared', 'host'] as const)(
    'moves to a new device id and leaves the list alone (%s mode, host-only device cookie)',
    async (mode) => {
      setMode(mode);
      await h.sys.hSet(accounts, '100', String(Date.now()));
      await h.sys.hSet(accounts, '200', String(Date.now()));
      const cookies = jar({ [HOST_DEVICE()]: 'dev-d' });

      await establishSession(cookies as never, asUser(300));

      const written = cookies.sets.filter((s) => s.name.endsWith('civ-device')).at(-1);
      expect(written?.value).toBeDefined();
      expect(written?.value).not.toBe('dev-d');
      expect([...(h.sys.hashes.get(accounts)?.keys() ?? [])].sort()).toEqual(['100', '200']);

      const switched = await visit(cookies, {
        path: '/api/auth/switch',
        routeId: '/api/auth/switch',
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ userId: 100 }),
        },
        run: (event) => switchPost(event) as Promise<Response>,
      });
      expect(switched.session?.sub).toBe('300');
      expect(switched.response.status).toBe(403);

      const listed = await visit(cookies, {
        path: '/api/auth/accounts',
        routeId: '/api/auth/accounts',
        run: (event) => accountsGet(event) as Promise<Response>,
      });
      const { accounts: list } = (await listed.response.json()) as {
        accounts: { userId: number }[];
      };
      expect(list.filter((a) => a.userId !== 300)).toEqual([]);
    }
  );
});
