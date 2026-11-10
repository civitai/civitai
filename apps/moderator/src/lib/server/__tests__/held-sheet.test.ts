import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The held-media sheet's sign-in (`auth/start`, `auth/exchange`) and the hook branch that lets its
 * cookie stand in for the web session on the image route. Redis is an in-memory fake that honours
 * EX/NX; the hub identity read and the web token verifier are replaced.
 */

type Entry = { value: string; expiresAt: number | null };

const {
  store,
  redis,
  getSessionUserById,
  verifyToken,
  isRevoked,
  guardCheck,
  loadPageAccessGrants,
} = vi.hoisted(() => {
  const store = new Map<string, Entry>();
  const live = (key: string) => {
    const e = store.get(key);
    if (e && e.expiresAt !== null && Date.now() >= e.expiresAt) store.delete(key);
    return store.get(key);
  };
  const redis = {
    set: vi.fn(async (key: string, value: string, opts?: { EX?: number; NX?: boolean }) => {
      if (opts?.NX && live(key)) return null;
      store.set(key, { value, expiresAt: opts?.EX ? Date.now() + opts.EX * 1000 : null });
      return 'OK';
    }),
    get: vi.fn(async (key: string) => live(key)?.value ?? null),
    getDel: vi.fn(async (key: string) => {
      const e = live(key);
      store.delete(key);
      return e?.value ?? null;
    }),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    expire: vi.fn(async (key: string, seconds: number) => {
      const e = live(key);
      if (!e) return 0;
      e.expiresAt = Date.now() + seconds * 1000;
      return 1;
    }),
  };
  return {
    store,
    redis,
    getSessionUserById: vi.fn(async (_id: number) => null as unknown),
    verifyToken: vi.fn(async (_token: string) => null as unknown),
    isRevoked: vi.fn(async (_claims: unknown) => false),
    guardCheck: vi.fn(async (_cookie: string, _url: string, _opts?: unknown) => ({} as unknown)),
    loadPageAccessGrants: vi.fn(async () => ({})),
  };
});

// held-media.ts (for HELD_MEDIA_PAGE) imports the database module, which needs env at load.
vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  return { dbRead: capturingDb([], []), dbWrite: capturingDb([], []) };
});
vi.mock('$lib/server/redis', () => ({ getSysRedis: () => redis }));
vi.mock('$lib/server/auth', () => ({
  guard: { check: guardCheck },
  isRevoked,
  admitsModerator: (u: { isModerator?: boolean }) => u.isModerator === true,
}));
vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@civitai/auth')>()),
  createSessionClient: () => ({ getSessionUserById }),
  createAuthVerifier: () => ({ verifyToken }),
}));
vi.mock('$lib/server/page-access', () => ({ loadPageAccessGrants }));
vi.mock('$lib/server/access', () => ({
  applyGrants: () => {},
  resolvePermissions: () => ({}),
  canAccess: (user: { roles?: string[] }, path: string) =>
    path === '/images/csam' && !!user.roles?.includes('moderator:senior'),
}));
vi.mock('$lib/server/axiom', () => ({
  logToAxiom: vi.fn(async () => undefined),
  logAxiomError: vi.fn(async () => undefined),
  safeError: (e: unknown) => ({ e }),
}));

const start = await import('../../../routes/api/held-media/auth/start/+server');
const exchange = await import('../../../routes/api/held-media/auth/exchange/+server');
const { handle } = await import('../../../hooks.server');

const ORIGIN = 'https://mod.test';
const VERIFIER = 'v'.repeat(20) + '-._~' + 'A1'.repeat(12);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const STATE = 'S'.repeat(24);
const MOD = { id: 42, username: 'mod42', isModerator: true, roles: ['moderator:senior'] };
const CLAIMS = { sub: '42', jti: 'web-session-1', signedAt: 1_000 };

const { hostSessionCookieName, sessionCookieName } = await import('@civitai/auth');
const WEB_COOKIE = `${hostSessionCookieName()}=web.jwt; ${sessionCookieName()}=web.jwt`;

const startQuery = (overrides: Record<string, string | null> = {}) => {
  const params: Record<string, string | null> = {
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: STATE,
    redirect_uri: 'hubapp://held-media',
    ...overrides,
  };
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null) u.set(k, v);
  return u;
};

async function startGet(query = startQuery(), user: unknown = MOD) {
  const url = new URL(`${ORIGIN}/api/held-media/auth/start?${query}`);
  return start.GET({ url, locals: { user }, request: new Request(url) } as never);
}

async function startPost(form = startQuery(), user: unknown = MOD) {
  const url = new URL(`${ORIGIN}/api/held-media/auth/start`);
  const request = new Request(url, {
    method: 'POST',
    headers: { cookie: WEB_COOKIE, 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  return start.POST({ url, locals: { user }, request } as never);
}

async function exchangePost(body: unknown, type = 'application/json') {
  const url = new URL(`${ORIGIN}/api/held-media/auth/exchange`);
  const request = new Request(url, {
    method: 'POST',
    headers: { 'content-type': type },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return exchange.POST({ url, request, locals: {} } as never);
}

/** Runs auth/start POST and returns the issued code. */
async function issue(): Promise<string> {
  const res = await startPost();
  expect(res.status).toBe(303);
  const location = new URL(res.headers.get('location')!);
  return location.searchParams.get('code')!;
}

/** Runs the full sign-in and returns the sheet cookie token. */
async function signIn(): Promise<string> {
  const res = await exchangePost({ code: await issue(), code_verifier: VERIFIER });
  expect(res.status).toBe(204);
  return /held_sheet=([^;]+)/.exec(res.headers.get('set-cookie')!)![1];
}

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  verifyToken.mockResolvedValue(CLAIMS);
  getSessionUserById.mockResolvedValue({ ...MOD });
  isRevoked.mockResolvedValue(false);
});
afterEach(() => vi.useRealTimers());

describe('auth/start', () => {
  it('answers a GET with a confirmation page and issues no code', async () => {
    const res = await startGet();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('mod42');
    expect(html).toContain('<form method="post">');
    expect(html).toContain(`value="${STATE}"`);
    expect(redis.set).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it('keeps the page and its redirect out of frames, caches and referrers', async () => {
    for (const res of [await startGet(), await startPost()]) {
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    }
  });

  it('escapes the username on the page', async () => {
    const html = await (await startGet(startQuery(), { ...MOD, username: '<b>x</b>' })).text();
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it.each([
    ['a plain challenge method', { code_challenge_method: 'plain' }],
    ['no challenge method', { code_challenge_method: null }],
    ['no challenge', { code_challenge: null }],
    ['a short challenge', { code_challenge: 'abc' }],
    ['no state', { state: null }],
    ['a short state', { state: 'abc' }],
    ['another redirect', { redirect_uri: 'hubapp://held-media/x' }],
    ['an https redirect', { redirect_uri: 'https://evil.test/cb' }],
    ['no redirect', { redirect_uri: null }],
  ])('refuses %s with 400 and no code, on GET and POST', async (_n, overrides) => {
    expect((await startGet(startQuery(overrides))).status).toBe(400);
    expect((await startPost(startQuery(overrides))).status).toBe(400);
    expect(store.size).toBe(0);
  });

  it('refuses a moderator without the held-media page', async () => {
    const user = { ...MOD, roles: ['moderator:staff'] };
    expect((await startGet(startQuery(), user)).status).toBe(403);
    expect((await startPost(startQuery(), user)).status).toBe(403);
    expect(store.size).toBe(0);
  });

  it('redirects the confirmed form to the sheet with a code and the state', async () => {
    const res = await startPost();
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get('location')!);
    expect(`${location.protocol}//${location.host}`).toBe('hubapp://held-media');
    expect(location.searchParams.get('state')).toBe(STATE);
    expect(location.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('stores the code by its hash for 60 s, bound to the challenge, state, redirect and session', async () => {
    const code = await issue();
    const key = `app:held-sheet:code:${createHash('sha256').update(code).digest('base64url')}`;
    expect([...store.keys()]).toEqual([key]);
    expect(redis.set.mock.calls[0][2]).toEqual({ EX: 60, NX: true });
    expect(JSON.parse(store.get(key)!.value)).toEqual({
      challenge: CHALLENGE,
      state: STATE,
      redirect: 'hubapp://held-media',
      userId: 42,
      jti: 'web-session-1',
      signedAt: 1_000,
    });
  });

  it('refuses a web session that is not the signed-in moderator, or an impersonation', async () => {
    verifyToken.mockResolvedValueOnce({ ...CLAIMS, sub: '43' });
    expect((await startPost()).status).toBe(403);
    verifyToken.mockResolvedValueOnce({ ...CLAIMS, impersonatedBy: 7 });
    expect((await startPost()).status).toBe(403);
    verifyToken.mockResolvedValueOnce(null);
    expect((await startPost()).status).toBe(403);
    expect(store.size).toBe(0);
  });
});

describe('auth/exchange', () => {
  it('trades a code and its verifier for the scoped cookie', async () => {
    const res = await exchangePost({ code: await issue(), code_verifier: VERIFIER });
    expect(res.status).toBe(204);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('set-cookie')).toMatch(
      /^held_sheet=[A-Za-z0-9_-]{43}; Path=\/api\/held-media\/; Max-Age=900; Secure; HttpOnly; SameSite=Strict$/
    );
  });

  it('refuses a replayed code', async () => {
    const code = await issue();
    expect((await exchangePost({ code, code_verifier: VERIFIER })).status).toBe(204);
    expect((await exchangePost({ code, code_verifier: VERIFIER })).status).toBe(400);
  });

  it.each([
    ['an empty verifier', ''],
    ['a missing verifier', undefined],
    ['a short verifier', 'abc'],
    ['a verifier with a bad character', 'v'.repeat(42) + '!'],
  ])('refuses %s', async (_n, codeVerifier) => {
    const code = await issue();
    expect((await exchangePost({ code, code_verifier: codeVerifier })).status).toBe(400);
  });

  it('burns the code on a wrong verifier, so the right one then fails too', async () => {
    const code = await issue();
    expect((await exchangePost({ code, code_verifier: 'w'.repeat(43) })).status).toBe(400);
    expect((await exchangePost({ code, code_verifier: VERIFIER })).status).toBe(400);
  });

  it('refuses a code after 60 s', async () => {
    vi.useFakeTimers();
    const code = await issue();
    vi.advanceTimersByTime(61_000);
    expect((await exchangePost({ code, code_verifier: VERIFIER })).status).toBe(400);
  });

  it('refuses a body that is not JSON', async () => {
    const code = await issue();
    const form = `code=${code}&code_verifier=${VERIFIER}`;
    expect((await exchangePost(form, 'text/plain')).status).toBe(400);
    expect((await exchangePost('not json')).status).toBe(400);
    // The code survives a body that never named it.
    expect((await exchangePost({ code, code_verifier: VERIFIER })).status).toBe(204);
  });
});

describe('hook: the sheet cookie', () => {
  async function run(path: string, cookie: string | null, method = 'GET') {
    const url = new URL(`${ORIGIN}${path}`);
    const headers = new Headers();
    if (cookie) headers.set('cookie', cookie);
    const event = {
      url,
      request: new Request(url, { method, headers }),
      locals: {} as Record<string, unknown>,
      route: { id: '/api/held-media/[imageId]' },
    };
    const resolve = vi.fn(async () => new Response(null, { status: 299 }));
    const res = await handle({ event, resolve } as never);
    return { res, resolve, locals: event.locals };
  }

  beforeEach(() => {
    guardCheck.mockResolvedValue({ status: 'reauth', authorize: 'https://hub.test/a' });
  });

  it('authenticates the image route as the moderator, marked as the sheet', async () => {
    const token = await signIn();
    const { res, locals } = await run('/api/held-media/7', `held_sheet=${token}`);
    expect(res.status).toBe(299);
    expect(locals.user).toMatchObject({ id: 42 });
    expect(locals.heldCredential).toBe('sheet');
    expect(guardCheck).not.toHaveBeenCalled();
  });

  it('answers 401 for an unknown or malformed cookie, and runs nothing', async () => {
    for (const cookie of [`held_sheet=${'x'.repeat(43)}`, 'held_sheet=short', 'held_sheet=']) {
      const { res, resolve } = await run('/api/held-media/7', cookie);
      expect(res.status).toBe(401);
      expect(resolve).not.toHaveBeenCalled();
    }
  });

  it('answers 401 when the moderator was demoted after signing in, and runs nothing', async () => {
    const token = await signIn();
    getSessionUserById.mockResolvedValue({ ...MOD, isModerator: false });
    const { res, resolve } = await run('/api/held-media/7', `held_sheet=${token}`);
    expect(res.status).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
    expect(getSessionUserById).toHaveBeenCalledWith(42);
  });

  it.each([
    ['banned', { bannedAt: new Date() }],
    ['deleted', { deletedAt: new Date() }],
  ])('answers 401 for a %s moderator', async (_n, change) => {
    const token = await signIn();
    getSessionUserById.mockResolvedValue({ ...MOD, ...change });
    expect((await run('/api/held-media/7', `held_sheet=${token}`)).res.status).toBe(401);
  });

  it('answers 401 once the web session that started it is revoked', async () => {
    const token = await signIn();
    isRevoked.mockResolvedValue(true);
    expect((await run('/api/held-media/7', `held_sheet=${token}`)).res.status).toBe(401);
    expect(isRevoked).toHaveBeenCalledWith({ jti: 'web-session-1', signedAt: 1_000 });
  });

  it('expires after 15 idle minutes, and each fetch restarts the clock', async () => {
    vi.useFakeTimers();
    const token = await signIn();
    vi.advanceTimersByTime(14 * 60_000);
    expect((await run('/api/held-media/7', `held_sheet=${token}`)).res.status).toBe(299);
    vi.advanceTimersByTime(14 * 60_000);
    expect((await run('/api/held-media/7', `held_sheet=${token}`)).res.status).toBe(299);
    vi.advanceTimersByTime(15 * 60_000 + 1);
    expect((await run('/api/held-media/7', `held_sheet=${token}`)).res.status).toBe(401);
  });

  it('expires 2 h after sign-in however active', async () => {
    vi.useFakeTimers();
    const token = await signIn();
    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(14 * 60_000);
      expect((await run('/api/held-media/7', `held_sheet=${token}`)).res.status).toBe(299);
    }
    vi.advanceTimersByTime(10 * 60_000);
    expect((await run('/api/held-media/7', `held_sheet=${token}`)).res.status).toBe(401);
  });

  it.each([
    ['opened/', '/api/held-media/7/opened', 'POST'],
    ['grid-view/', '/api/held-media/grid-view', 'POST'],
    ['auth/start', '/api/held-media/auth/start', 'GET'],
    ['a POST to the image', '/api/held-media/7', 'POST'],
    ['an image path with a suffix', '/api/held-media/7x', 'GET'],
  ])('ignores the cookie on %s and asks the web guard', async (_n, path, method) => {
    const token = await signIn();
    const { res, resolve, locals } = await run(path, `held_sheet=${token}`, method);
    expect(guardCheck).toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
    expect(locals.heldCredential).toBeUndefined();
  });

  it('lets the exchange through without a web session', async () => {
    const { res } = await run('/api/held-media/auth/exchange', null, 'POST');
    expect(res.status).toBe(299);
    expect(guardCheck).not.toHaveBeenCalled();
  });

  it('logs no code, verifier, state or token on any path', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { logToAxiom, logAxiomError } = await import('$lib/server/axiom');
    const code = await issue();
    const token = await signIn();
    // Failure paths that log.
    redis.set.mockRejectedValueOnce(new Error('redis down'));
    expect((await startPost()).status).toBe(503);
    redis.getDel.mockRejectedValueOnce(new Error('redis down'));
    expect((await exchangePost({ code, code_verifier: VERIFIER })).status).toBe(503);
    redis.get.mockRejectedValueOnce(new Error('redis down'));
    expect((await run('/api/held-media/7', `held_sheet=${token}`)).res.status).toBe(401);

    const logged = JSON.stringify([
      errors.mock.calls,
      warns.mock.calls,
      vi.mocked(logToAxiom).mock.calls,
      vi.mocked(logAxiomError).mock.calls,
    ]);
    expect(errors).toHaveBeenCalled();
    for (const secret of [code, token, VERIFIER, STATE, CHALLENGE])
      expect(logged).not.toContain(secret);
    errors.mockRestore();
    warns.mockRestore();
  });
});
