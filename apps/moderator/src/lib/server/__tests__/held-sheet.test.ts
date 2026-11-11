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
const CALLBACK = 'https://sheet.test/held-media/callback';
const VERIFIER = 'v'.repeat(20) + '-._~' + 'A1'.repeat(12);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const STATE = 'S'.repeat(24);
const MOD = { id: 42, username: 'mod42', isModerator: true, roles: ['moderator:senior'] };
const CLAIMS = { sub: '42', sid: 'family-1', jti: 'web-session-1', signedAt: 1_000, iat: 5 };
const WEB = { sub: '42', sid: 'family-1', jti: 'web-session-1', signedAt: 1_000 };

const { hostSessionCookieName, sessionCookieName } = await import('@civitai/auth');
const WEB_COOKIE = `${hostSessionCookieName()}=web.jwt; ${sessionCookieName()}=web.jwt`;

const startQuery = (overrides: Record<string, string | null> = {}) => {
  const params: Record<string, string | null> = {
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: STATE,
    redirect_uri: CALLBACK,
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
  return /__Secure-held_sheet=([^;]+)/.exec(res.headers.get('set-cookie')!)![1];
}

beforeEach(() => {
  process.env.HELD_SHEET_CALLBACK_URL = CALLBACK;
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
      // no-referrer would make the form POST carry `Origin: null`, which SvelteKit refuses.
      expect(res.headers.get('referrer-policy')).toBe('same-origin');
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
    ['the custom scheme', { redirect_uri: 'hubapp://held-media' }],
    ['another host', { redirect_uri: 'https://evil.test/held-media/callback' }],
    ['a longer path', { redirect_uri: `${CALLBACK}/x` }],
    ['a shorter path', { redirect_uri: 'https://sheet.test/held-media' }],
    ['a query', { redirect_uri: `${CALLBACK}?a=1` }],
    ['a fragment', { redirect_uri: `${CALLBACK}#a` }],
    ['http', { redirect_uri: CALLBACK.replace('https:', 'http:') }],
    ['a different case', { redirect_uri: CALLBACK.toUpperCase() }],
    ['a different host case', { redirect_uri: 'https://SHEET.test/held-media/callback' }],
    ['a port', { redirect_uri: 'https://sheet.test:8443/held-media/callback' }],
    ['no redirect', { redirect_uri: null }],
  ])('refuses %s with 400 and no code, on GET and POST', async (_n, overrides) => {
    expect((await startGet(startQuery(overrides))).status).toBe(400);
    expect((await startPost(startQuery(overrides))).status).toBe(400);
    expect(store.size).toBe(0);
  });

  it.each([
    ['unset', undefined],
    ['http', CALLBACK.replace('https:', 'http:')],
    ['with a query', `${CALLBACK}?a=1`],
    ['not normalised', 'https://SHEET.test/held-media/callback'],
    ['ending in ?', `${CALLBACK}?`],
    ['ending in #', `${CALLBACK}#`],
    ['with credentials', 'https://u:p@sheet.test/held-media/callback'],
    ['with the default port', 'https://sheet.test:443/held-media/callback'],
    ['a bare origin', 'https://sheet.test'],
    ['a unicode host', 'https://bücher.test/held-media/callback'],
  ])('refuses every redirect when the callback setting is %s', async (_n, value) => {
    if (value === undefined) delete process.env.HELD_SHEET_CALLBACK_URL;
    else process.env.HELD_SHEET_CALLBACK_URL = value;
    const query = startQuery(value === undefined ? {} : { redirect_uri: value });
    expect((await startGet(query)).status).toBe(400);
    expect((await startPost(query)).status).toBe(400);
    expect(store.size).toBe(0);
  });

  it('reads the callback setting with surrounding whitespace trimmed', async () => {
    process.env.HELD_SHEET_CALLBACK_URL = `  ${CALLBACK}\n`;
    expect((await startPost()).status).toBe(303);
  });

  it('lets the confirmed form go only to the callback origin', async () => {
    const csp = (await startGet()).headers.get('content-security-policy')!;
    expect(csp).toContain("form-action 'self' https://sheet.test;");
    expect(csp).not.toContain('hubapp');
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
    expect(`${location.origin}${location.pathname}`).toBe(CALLBACK);
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
      redirect: CALLBACK,
      userId: 42,
      web: WEB,
    });
  });

  it('refuses a web session that is not the signed-in moderator, or an impersonation', async () => {
    verifyToken.mockResolvedValueOnce({ ...CLAIMS, sub: '43' });
    expect((await startPost()).status).toBe(403);
    verifyToken.mockResolvedValueOnce({ ...CLAIMS, impersonatedBy: 7 });
    expect((await startPost()).status).toBe(403);
    verifyToken.mockResolvedValueOnce(null);
    expect((await startPost()).status).toBe(403);
    verifyToken.mockResolvedValueOnce({ ...CLAIMS, jti: undefined });
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
      /^__Secure-held_sheet=[A-Za-z0-9_-]{43}; Path=\/api\/held-media\/; Max-Age=900; Secure; HttpOnly; SameSite=Strict$/
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
  ])('refuses %s, without burning the code', async (_n, codeVerifier) => {
    const code = await issue();
    expect((await exchangePost({ code, code_verifier: codeVerifier })).status).toBe(400);
    expect((await exchangePost({ code, code_verifier: VERIFIER })).status).toBe(204);
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
    guardCheck.mockResolvedValue({
      status: 'reauth',
      authorize: 'https://hub.test/a',
      reason: 'no-session',
    });
  });

  it('authenticates the image route as the moderator, marked as the sheet', async () => {
    const token = await signIn();
    const { res, locals } = await run('/api/held-media/7', `__Secure-held_sheet=${token}`);
    expect(res.status).toBe(299);
    expect(locals.user).toMatchObject({ id: 42 });
    expect(locals.heldCredential).toBe('sheet');
    // Asked first, and found no web session.
    expect(guardCheck).toHaveBeenCalledTimes(1);
  });

  it('lets a valid web session win over a sheet cookie on the image route', async () => {
    const token = await signIn();
    const webUser = { ...MOD, id: 77, username: 'web77' };
    guardCheck.mockResolvedValue({ status: 'ok', user: webUser, setCookies: [] });
    redis.get.mockClear();
    const { res, locals } = await run('/api/held-media/7', `__Secure-held_sheet=${token}`);
    expect(res.status).toBe(299);
    expect(locals.user).toMatchObject({ id: 77 });
    expect(locals.heldCredential).toBeUndefined();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('falls back to a valid web session, not 401, when the sheet cookie is dead', async () => {
    guardCheck.mockResolvedValue({ status: 'ok', user: { ...MOD }, setCookies: [] });
    redis.get.mockClear();
    const { res, locals } = await run('/api/held-media/7', `__Secure-held_sheet=${'x'.repeat(43)}`);
    expect(res.status).toBe(299);
    expect(locals.heldCredential).toBeUndefined();
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('keeps the web session cookie the guard rolled when the web session wins', async () => {
    const token = await signIn();
    guardCheck.mockResolvedValue({
      status: 'ok',
      user: { ...MOD },
      setCookies: ['civ-token=rolled; Path=/; HttpOnly'],
    });
    const { res } = await run('/api/held-media/7', `__Secure-held_sheet=${token}`);
    expect(res.headers.get('set-cookie')).toContain('civ-token=rolled');
  });

  it.each([
    ['login', { status: 'login', redirect: 'https://hub.test/login', reason: 'no-session' }],
    ['reauth', { status: 'reauth', authorize: 'https://hub.test/a', reason: 'no-session' }],
    ['invalid login', { status: 'login', redirect: 'https://hub.test/login', reason: 'invalid' }],
    ['invalid reauth', { status: 'reauth', authorize: 'https://hub.test/a', reason: 'invalid' }],
  ])('uses the sheet when there is no valid web session (%s)', async (_n, web) => {
    const token = await signIn();
    guardCheck.mockResolvedValue(web);
    const { res, locals } = await run('/api/held-media/7', `__Secure-held_sheet=${token}`);
    expect(res.status).toBe(299);
    expect(locals.heldCredential).toBe('sheet');
    expect(locals.user).toMatchObject({ id: 42 });
  });

  it.each([
    ['login', { status: 'login', redirect: 'https://hub.test/login', reason: 'unavailable' }],
    ['reauth', { status: 'reauth', authorize: 'https://hub.test/a', reason: 'unavailable' }],
  ])(
    'answers 503 when the web session cannot be resolved, without using or clearing the sheet (%s)',
    async (_n, web) => {
      const token = await signIn();
      guardCheck.mockResolvedValue(web);
      redis.get.mockClear();
      const { res, resolve, locals } = await run(
        '/api/held-media/7',
        `${WEB_COOKIE}; __Secure-held_sheet=${token}`
      );
      expect(res.status).toBe(503);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(resolve).not.toHaveBeenCalled();
      expect(locals.heldCredential).toBeUndefined();
      expect(redis.get).not.toHaveBeenCalled();
    }
  );

  it('sends a valid shared web session that needs this host cookie to sign in, not to the sheet', async () => {
    const token = await signIn();
    guardCheck.mockResolvedValue({
      status: 'login',
      redirect: 'https://mod.test/api/auth/authorize',
      reason: 'host-cookie',
    });
    redis.get.mockClear();
    const { res, resolve, locals } = await run('/api/held-media/7', `__Secure-held_sheet=${token}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://mod.test/api/auth/authorize');
    expect(resolve).not.toHaveBeenCalled();
    expect(locals.heldCredential).toBeUndefined();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('refuses a sheet cookie beside a signed-in non-moderator, without looking it up', async () => {
    const token = await signIn();
    guardCheck.mockResolvedValue({ status: 'forbidden', user: { id: 5 } });
    redis.get.mockClear();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { res, resolve, locals } = await run('/api/held-media/7', `__Secure-held_sheet=${token}`);
    expect(res.status).toBe(403);
    expect(resolve).not.toHaveBeenCalled();
    expect(locals.heldCredential).toBeUndefined();
    expect(redis.get).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[held-sheet] sheet cookie refused beside a non-moderator session'
    );
    const { logToAxiom } = await import('$lib/server/axiom');
    expect(vi.mocked(logToAxiom)).toHaveBeenCalledWith({
      name: 'held-sheet-refused-beside-session',
      type: 'warning',
      userId: 5,
    });
    warn.mockRestore();
  });

  it('sends a signed-in non-moderator with no sheet cookie to the usual redirect', async () => {
    guardCheck.mockResolvedValue({ status: 'forbidden', user: { id: 5 } });
    const { res, resolve } = await run('/api/held-media/7', null);
    expect(res.status).toBe(303);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('answers 401 to two sheet cookies, even when one is valid', async () => {
    const token = await signIn();
    const other = 'o'.repeat(43);
    for (const cookie of [
      `__Secure-held_sheet=${token}; __Secure-held_sheet=${other}`,
      `__Secure-held_sheet=${other}; __Secure-held_sheet=${token}`,
    ]) {
      const { res, resolve } = await run('/api/held-media/7', cookie);
      expect(res.status).toBe(401);
      expect(resolve).not.toHaveBeenCalled();
    }
  });

  it('counts a sheet cookie written with a space before the =', async () => {
    const token = await signIn();
    const cookie = `__Secure-held_sheet =${token}; __Secure-held_sheet=${'o'.repeat(43)}`;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await run('/api/held-media/7', cookie)).res.status).toBe(401);
    expect(warn).toHaveBeenCalledWith('[held-sheet] duplicate sheet cookies refused', { count: 2 });
    warn.mockRestore();
  });

  describe('with a service token', () => {
    beforeEach(() => {
      process.env.MOD_INBOUND_TOKEN = 'sk-inbound-held-test';
    });
    afterEach(() => {
      delete process.env.MOD_INBOUND_TOKEN;
    });

    it('refuses a wrong token before the sheet cookie is looked at', async () => {
      const token = await signIn();
      redis.get.mockClear();
      const { res, resolve } = await run(
        '/api/held-media/7?token=wrong-token',
        `__Secure-held_sheet=${token}`
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(resolve).not.toHaveBeenCalled();
      expect(guardCheck).not.toHaveBeenCalled();
      expect(redis.get).not.toHaveBeenCalled();
    });

    it('treats a valid token as the token client, not the sheet', async () => {
      const token = await signIn();
      const { res, locals } = await run(
        '/api/held-media/7?token=sk-inbound-held-test',
        `__Secure-held_sheet=${token}`
      );
      expect(res.status).toBe(299);
      expect(locals.tokenClient).toBe('webhook');
      expect(locals.heldCredential).toBeUndefined();
      expect(guardCheck).not.toHaveBeenCalled();
    });
  });

  it('asks the web guard once per request', async () => {
    const token = await signIn();
    guardCheck.mockResolvedValue({ status: 'ok', user: { ...MOD }, setCookies: [] });
    await run('/api/held-media/7', `__Secure-held_sheet=${token}`);
    expect(guardCheck).toHaveBeenCalledTimes(1);
  });

  it('answers 401 for an unknown or malformed cookie, and runs nothing', async () => {
    for (const cookie of [
      `__Secure-held_sheet=${'x'.repeat(43)}`,
      '__Secure-held_sheet=short',
      '__Secure-held_sheet=',
    ]) {
      const { res, resolve } = await run('/api/held-media/7', cookie);
      expect(res.status).toBe(401);
      expect(resolve).not.toHaveBeenCalled();
      expect(res.headers.get('set-cookie')).toBe(
        '__Secure-held_sheet=; Path=/api/held-media/; Max-Age=0; Secure; HttpOnly; SameSite=Strict'
      );
    }
  });

  it('answers 401 when the moderator was demoted after signing in, and runs nothing', async () => {
    const token = await signIn();
    getSessionUserById.mockResolvedValue({ ...MOD, isModerator: false });
    const { res, resolve } = await run('/api/held-media/7', `__Secure-held_sheet=${token}`);
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
    expect((await run('/api/held-media/7', `__Secure-held_sheet=${token}`)).res.status).toBe(401);
  });

  it('answers 401 once the web session that started it is revoked', async () => {
    const token = await signIn();
    isRevoked.mockResolvedValue(true);
    expect((await run('/api/held-media/7', `__Secure-held_sheet=${token}`)).res.status).toBe(401);
    expect(isRevoked).toHaveBeenCalledWith(WEB);
  });

  it('expires after 15 idle minutes, and each fetch restarts the clock', async () => {
    vi.useFakeTimers();
    const token = await signIn();
    vi.advanceTimersByTime(14 * 60_000);
    expect((await run('/api/held-media/7', `__Secure-held_sheet=${token}`)).res.status).toBe(299);
    vi.advanceTimersByTime(14 * 60_000);
    expect((await run('/api/held-media/7', `__Secure-held_sheet=${token}`)).res.status).toBe(299);
    vi.advanceTimersByTime(15 * 60_000 + 1);
    expect((await run('/api/held-media/7', `__Secure-held_sheet=${token}`)).res.status).toBe(401);
  });

  it('expires 2 h after sign-in however active', async () => {
    vi.useFakeTimers();
    const token = await signIn();
    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(14 * 60_000);
      expect((await run('/api/held-media/7', `__Secure-held_sheet=${token}`)).res.status).toBe(299);
    }
    vi.advanceTimersByTime(10 * 60_000);
    expect((await run('/api/held-media/7', `__Secure-held_sheet=${token}`)).res.status).toBe(401);
  });

  it.each([
    ['opened/', '/api/held-media/7/opened', 'POST'],
    ['grid-view/', '/api/held-media/grid-view', 'POST'],
    ['auth/start', '/api/held-media/auth/start', 'GET'],
    ['a POST to the image', '/api/held-media/7', 'POST'],
    ['an image path with a suffix', '/api/held-media/7x', 'GET'],
  ])('ignores the cookie on %s and asks the web guard', async (_n, path, method) => {
    const token = await signIn();
    const { res, resolve, locals } = await run(path, `__Secure-held_sheet=${token}`, method);
    expect(guardCheck).toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
    expect(locals.heldCredential).toBeUndefined();
  });

  it('lets the exchange through without a web session, for a POST only', async () => {
    const { res } = await run('/api/held-media/auth/exchange', null, 'POST');
    expect(res.status).toBe(299);
    expect(guardCheck).not.toHaveBeenCalled();
    expect((await run('/api/held-media/auth/exchange', null, 'GET')).res.status).toBe(401);
    expect(guardCheck).toHaveBeenCalled();
  });

  it('answers 503, not 401, when the session store cannot be read', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const token = await signIn();
    redis.get.mockRejectedValueOnce(new Error('redis down'));
    const { res, resolve } = await run('/api/held-media/7', `__Secure-held_sheet=${token}`);
    expect(res.status).toBe(503);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('logs no code, verifier, state or token on any path', async () => {
    const { inspect } = await import('node:util');
    const spies = (['log', 'info', 'debug', 'warn', 'error'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {})
    );
    const { logToAxiom, logAxiomError } = await import('$lib/server/axiom');
    // Success paths.
    expect((await startGet()).status).toBe(200);
    const code = await issue();
    const token = await signIn();
    expect((await run('/api/held-media/7', `__Secure-held_sheet=${token}`)).res.status).toBe(299);
    // Failure paths that log.
    redis.set.mockRejectedValueOnce(new Error('redis down'));
    expect((await startPost()).status).toBe(503);
    redis.getDel.mockRejectedValueOnce(new Error('redis down'));
    expect((await exchangePost({ code, code_verifier: VERIFIER })).status).toBe(503);
    redis.get.mockRejectedValueOnce(new Error('redis down'));
    expect((await run('/api/held-media/7', `__Secure-held_sheet=${token}`)).res.status).toBe(503);
    getSessionUserById.mockResolvedValueOnce(null);
    expect((await run('/api/held-media/7', `__Secure-held_sheet=${token}`)).res.status).toBe(401);

    const calls = [
      ...spies.flatMap((spy) => spy.mock.calls),
      ...vi.mocked(logToAxiom).mock.calls,
      ...vi.mocked(logAxiomError).mock.calls,
    ];
    // inspect, not JSON.stringify: an Error stringifies to `{}` and would hide its message.
    const logged = calls
      .flat()
      .map((arg) => inspect(arg, { depth: 8 }))
      .join('\n');
    expect(spies[4]).toHaveBeenCalled();
    for (const secret of [code, token, VERIFIER, STATE, CHALLENGE])
      expect(logged).not.toContain(secret);
    spies.forEach((spy) => spy.mockRestore());
  });
});
