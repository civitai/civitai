import { describe, it, expect, vi } from 'vitest';

// Tests the retry-tolerant loop recovery in src/pages/api/auth/authorize.ts. A stale post-login marker with no
// session cookie must RETRY the login once (consume marker, set retry=1, redirect) and only show the terminal
// "We couldn't sign you in" page on the SECOND consecutive miss — so an intermittent cookie-landing miss
// self-heals instead of hard-failing.

// Deterministic hub + authorize redirect so we can exercise cookie/recovery logic without real PKCE/env.
vi.mock('~/server/auth/oauth-bridge', () => ({
  HUB_BASE_URL: 'https://auth.test',
  resolveSelfOrigin: () => 'https://civitai.red',
  safePath: (p: unknown) => (typeof p === 'string' ? p : '/'),
  clearBridgeCookie: () => 'oauth_bridge=; Path=/; Max-Age=0; SameSite=Lax',
  buildBridgeProbeCookie: () =>
    'oauth_bridge_probe=xyz; Path=/api/auth/callback; HttpOnly; SameSite=None; Secure; Max-Age=3600',
  buildAuthorizeRedirect: () => ({
    location: 'https://auth.test/api/auth/oauth/authorize?x=1',
    setCookie: ['oauth_bridge=abc; Path=/; SameSite=Lax'],
  }),
}));

import handler from '~/pages/api/auth/authorize';
import { sessionCookieName } from '@civitai/auth';
import { POST_LOGIN_MARKER, LOGIN_RETRY_COOKIE } from '../civ-cookie';

function createMocks({
  cookies = {},
  headers = { host: 'civitai.red' },
  query = {},
}: {
  cookies?: Record<string, string>;
  headers?: Record<string, string>;
  query?: Record<string, string>;
} = {}) {
  const req = { cookies, headers, query } as never;
  let statusCode = 200;
  let body: unknown;
  let redirectedTo: string | undefined;
  let setCookies: string[] = [];
  const res = {
    status(c: number) {
      statusCode = c;
      return res;
    },
    setHeader(name: string, value: unknown) {
      if (name.toLowerCase() === 'set-cookie')
        setCookies = Array.isArray(value) ? (value as string[]) : [String(value)];
      return res;
    },
    send(b: unknown) {
      body = b;
      return res;
    },
    json() {
      return res;
    },
    redirect(code: number, url: string) {
      statusCode = code;
      redirectedTo = url;
      return res;
    },
    _status: () => statusCode,
    _body: () => body,
    _redirect: () => redirectedTo,
    _cookies: () => setCookies,
  };
  return { req, res: res as never, out: () => ({ statusCode, body, redirectedTo, setCookies }) };
}

const cookieStr = (cookies: string[], name: string) =>
  cookies.find((c) => c.startsWith(`${name}=`));
const SESSION = sessionCookieName();

describe('/api/auth/authorize — retry-tolerant loop recovery', () => {
  it('FIRST miss (marker, no session) → retries: redirects, consumes marker, sets retry=1', () => {
    const { req, res, out } = createMocks({ cookies: { [POST_LOGIN_MARKER]: '1' } });
    handler(req, res);
    const { statusCode, redirectedTo, setCookies } = out();

    expect(statusCode).toBe(302); // NOT the 400 page
    expect(redirectedTo).toContain('auth.test/api/auth/oauth/authorize');
    // marker consumed (cleared) + retry counter set to 1
    expect(cookieStr(setCookies, POST_LOGIN_MARKER)).toMatch(/Max-Age=0/);
    expect(cookieStr(setCookies, LOGIN_RETRY_COOKIE)).toMatch(
      new RegExp(`${LOGIN_RETRY_COOKIE}=1`)
    );
    // bridge cookie still emitted
    expect(cookieStr(setCookies, 'oauth_bridge')).toBeDefined();
  });

  it('SECOND consecutive miss (marker + retry=1, no session) → terminal 400 page', () => {
    const { req, res, out } = createMocks({
      cookies: { [POST_LOGIN_MARKER]: '1', [LOGIN_RETRY_COOKIE]: '1' },
    });
    handler(req, res);
    const { statusCode, body, setCookies } = out();

    expect(statusCode).toBe(400);
    expect(String(body)).toContain("We couldn't sign you in");
    // wipes the wedged cookies incl. marker + retry
    expect(cookieStr(setCookies, POST_LOGIN_MARKER)).toMatch(/Max-Age=0/);
    expect(cookieStr(setCookies, LOGIN_RETRY_COOKIE)).toMatch(/Max-Age=0/);
  });

  it('clean entry with a stale retry cookie (no marker) → redirects, resets the retry budget', () => {
    const { req, res, out } = createMocks({ cookies: { [LOGIN_RETRY_COOKIE]: '1' } });
    handler(req, res);
    const { statusCode, setCookies } = out();

    expect(statusCode).toBe(302);
    expect(cookieStr(setCookies, LOGIN_RETRY_COOKIE)).toMatch(/Max-Age=0/); // reset
  });

  it('normal login (no marker, no retry) → just redirects with the bridge cookie', () => {
    const { req, res, out } = createMocks({ cookies: {} });
    handler(req, res);
    const { statusCode, setCookies } = out();

    expect(statusCode).toBe(302);
    expect(cookieStr(setCookies, 'oauth_bridge')).toBeDefined();
    expect(cookieStr(setCookies, LOGIN_RETRY_COOKIE)).toBeUndefined();
    expect(cookieStr(setCookies, POST_LOGIN_MARKER)).toBeUndefined();
  });

  it('marker present but session ALSO present (add-account) → no 400, no retry bump', () => {
    const { req, res, out } = createMocks({
      cookies: { [POST_LOGIN_MARKER]: '1', [SESSION]: 'tok' },
    });
    handler(req, res);
    const { statusCode, setCookies } = out();

    expect(statusCode).toBe(302);
    expect(cookieStr(setCookies, LOGIN_RETRY_COOKIE)).toBeUndefined();
  });
});
