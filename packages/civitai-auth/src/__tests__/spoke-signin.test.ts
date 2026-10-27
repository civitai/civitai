import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ loadAuthEnv: vi.fn() }));
vi.mock('../env', () => ({ loadAuthEnv: h.loadAuthEnv }));

import {
  isNavigationRequest,
  spokeAuthorize,
  spokeCallback,
  spokeReauthResponse,
  withSetCookies,
} from '../spoke-signin';

const HUB = 'https://auth.civitai.com';
const SELF = 'https://moderator.civitai.com';
const HOST = '__Host-civ-token';
const ORIGINAL_ENV = { ...process.env };

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
// The cookie's Max-Age is exp minus now, so the clock is pinned: a second ticking during the run would change it.
const NOW = Date.UTC(2026, 0, 1);
const TOKEN = `${b64({ alg: 'ES256' })}.${b64({ exp: NOW / 1000 + 3600 })}.sig`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  process.env.AUTH_JWT_ISSUER = HUB;
  h.loadAuthEnv.mockReturnValue({ AUTH_JWT_ISSUER: HUB });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      String(url).endsWith('/api/auth/oauth/session')
        ? Response.json({ token: TOKEN, deviceId: 'D1' })
        : new Response(null, { status: 404 })
    )
  );
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A browser cookie jar for one host: applies Set-Cookie, optionally dropping one name (a cookie that never lands). */
function browser(drop?: string) {
  const jar = new Map<string, string>();
  return {
    jar,
    header: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    apply(res: Response) {
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const name = pair.slice(0, pair.indexOf('='));
        const value = pair.slice(pair.indexOf('=') + 1);
        if (name === drop) continue;
        if (/Max-Age=0(;|$)/.test(c)) jar.delete(name);
        else jar.set(name, value);
      }
    },
    get(path: string) {
      return new Request(`${SELF}${path}`, { headers: { cookie: this.header() } });
    },
  };
}

/** The hub's side of the round trip: send back a code with the state the spoke stashed. */
function hubReturn(authorize: Response): string {
  const state = new URL(authorize.headers.get('location')!).searchParams.get('state');
  return `/api/auth/callback?code=c1&state=${state}`;
}

describe('spokeAuthorize / spokeCallback', () => {
  it('signs in: the callback sets the host-only session and device cookies and returns to the page', async () => {
    const b = browser();
    const start = spokeAuthorize(b.get('/api/auth/authorize?returnUrl=%2Freports%2F7'));
    expect(start.status).toBe(302);
    expect(start.headers.get('location')).toMatch(`${HUB}/api/auth/oauth/authorize?`);
    expect(start.headers.get('referrer-policy')).toBe('no-referrer');
    b.apply(start);

    const done = await spokeCallback(b.get(hubReturn(start)));
    expect(done.status).toBe(302);
    expect(done.headers.get('location')).toBe('/reports/7');
    expect(done.headers.get('referrer-policy')).toBe('no-referrer');
    const set = done.headers.getSetCookie();
    expect(set).toContain(`${HOST}=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=3600`);
    expect(set).toContain(
      '__Host-civ-device=D1; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=2592000'
    );
    expect(set.filter((c) => c.startsWith('__Host-')).some((c) => /Domain=/.test(c))).toBe(false);
    b.apply(done);
    expect(b.jar.get(HOST)).toBe(TOKEN);
    expect(b.jar.get('civ_postlogin')).toBe('1');
  });

  it('expires the shared pair host-only when the callback request carries it', async () => {
    const b = browser();
    b.jar.set('__Secure-civ-token', 'old');
    const start = spokeAuthorize(b.get('/api/auth/authorize'));
    b.apply(start);
    const set = (await spokeCallback(b.get(hubReturn(start)))).headers.getSetCookie();
    expect(set).toContain('__Secure-civ-token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure');
    expect(set.some((c) => c.startsWith('__Secure-civ-device='))).toBe(false);
  });

  it('a failed exchange shows the problem page rather than redirecting', async () => {
    const b = browser();
    const res = await spokeCallback(b.get('/api/auth/callback?code=c1&state=nope'));
    expect(res.status).toBe(400);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await res.text()).toMatch(/couldn't sign you in/);
  });

  it('a session cookie that never lands: the first miss retries, the second shows the problem page', async () => {
    const b = browser(HOST);
    const events: string[] = [];
    const onEvent = (e: string) => events.push(e);
    let rounds = 0;
    let res = spokeAuthorize(b.get('/api/auth/authorize?returnUrl=%2F'), { onEvent });
    // Each round: hub → callback (cookie dropped) → the page bounces back to authorize. Capped so a loop fails.
    while (res.status === 302 && rounds < 10) {
      rounds++;
      b.apply(res);
      b.apply(await spokeCallback(b.get(hubReturn(res))));
      res = spokeAuthorize(b.get('/api/auth/authorize?returnUrl=%2F'), { onEvent });
    }
    expect(rounds).toBeLessThan(3);
    expect(events).toEqual(['cookie-miss-retry', 'loop-terminal']);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/couldn't sign you in/);
    b.apply(res);
    expect(b.jar.has('civ_postlogin')).toBe(false);
    expect(b.jar.has('civ_login_retry')).toBe(false);
  });

  it('the problem page clears only this host: the shared session cookies are left alone', async () => {
    const b = browser(HOST);
    b.jar.set('civ_postlogin', '1');
    b.jar.set('civ_login_retry', '1');
    b.jar.set('__Host-civ-device', 'D1');
    b.jar.set('__Secure-civ-token', 'shared');
    b.jar.set('__Secure-civ-device', 'shared-device');
    const res = spokeAuthorize(b.get('/api/auth/authorize?returnUrl=%2F'));
    expect(res.status).toBe(400);
    const set = res.headers.getSetCookie();
    expect(set.filter((c) => /^(__Secure-)?civ-(token|device)=/.test(c))).toEqual([]);
    expect(set.some((c) => /Domain=/.test(c))).toBe(false);
    expect(set).toContain('__Host-civ-token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure');
    expect(set).toContain('__Host-civ-device=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure');
  });

  it('a cookie that lands on the retry signs in normally', async () => {
    const flaky = browser(HOST);
    let res = spokeAuthorize(flaky.get('/api/auth/authorize'));
    flaky.apply(res);
    flaky.apply(await spokeCallback(flaky.get(hubReturn(res))));
    res = spokeAuthorize(flaky.get('/api/auth/authorize'));
    expect(res.status).toBe(302);

    const b = browser();
    for (const [k, v] of flaky.jar) b.jar.set(k, v);
    b.apply(res);
    b.apply(await spokeCallback(b.get(hubReturn(res))));
    expect(b.jar.get(HOST)).toBe(TOKEN);
  });

  it('a signed-in add-account re-entry (marker and cookie both present) is not treated as a miss', () => {
    const b = browser();
    b.jar.set('civ_postlogin', '1');
    b.jar.set(HOST, TOKEN);
    const events: string[] = [];
    const res = spokeAuthorize(b.get('/api/auth/authorize'), { onEvent: (e) => events.push(e) });
    expect(res.status).toBe(302);
    expect(events).toEqual([]);
  });

  it('500s without a hub', () => {
    h.loadAuthEnv.mockReturnValue({});
    expect(spokeAuthorize(new Request(`${SELF}/api/auth/authorize`)).status).toBe(500);
  });
});

describe('isNavigationRequest', () => {
  const req = (init: RequestInit & { path?: string } = {}) =>
    new Request(`${SELF}${init.path ?? '/reports'}`, init);
  it.each([
    ['a page load', req({ headers: { 'sec-fetch-mode': 'navigate' } }), true],
    ['a fetch', req({ headers: { 'sec-fetch-mode': 'cors' } }), false],
    ['a POST', req({ method: 'POST', headers: { 'sec-fetch-mode': 'navigate' } }), false],
    [
      'a SvelteKit data request',
      req({ path: '/reports/__data.json', headers: { 'sec-fetch-mode': 'cors' } }),
      true,
    ],
    ['no fetch metadata, html accepted', req({ headers: { accept: 'text/html,*/*' } }), true],
    ['no fetch metadata, json', req({ headers: { accept: 'application/json' } }), false],
  ])('%s → %s', (_l, r, want) => expect(isNavigationRequest(r)).toBe(want));
});

describe('spokeReauthResponse / withSetCookies', () => {
  it('answers 401 with the authorize URL in a header and the body', async () => {
    const res = spokeReauthResponse(`${SELF}/api/auth/authorize?returnUrl=%2F`);
    expect(res.status).toBe(401);
    expect(res.headers.get('x-session-reauth')).toBe(`${SELF}/api/auth/authorize?returnUrl=%2F`);
    expect(await res.json()).toEqual({
      error: 'reauth',
      authorize: `${SELF}/api/auth/authorize?returnUrl=%2F`,
    });
  });

  it('adds cookies to a response whose headers are immutable', () => {
    const immutable = new Response('x');
    Object.defineProperty(immutable.headers, 'append', {
      value: () => {
        throw new TypeError('immutable');
      },
    });
    const out = withSetCookies(immutable, ['a=1']);
    expect(out).not.toBe(immutable);
    expect(out.headers.getSetCookie()).toEqual(['a=1']);
  });
});
