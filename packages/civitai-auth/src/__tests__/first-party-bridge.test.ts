import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ loadAuthEnv: vi.fn() }));
vi.mock('../env', () => ({ loadAuthEnv: h.loadAuthEnv }));

import {
  buildAuthorizeRedirect,
  completeFirstPartyCallback,
  clearBridgeCookie,
  safePath,
  generatePkce,
  OAUTH_BRIDGE_COOKIE,
} from '../first-party-bridge';
import { firstPartyClientId } from '../first-party';

const HUB = 'https://auth.test';
const SELF = 'https://moderator.civitai.com';

beforeEach(() => {
  process.env.AUTH_JWT_ISSUER = HUB; // https → secure cookie
  h.loadAuthEnv.mockReturnValue({ AUTH_JWT_ISSUER: HUB });
});
afterEach(() => {
  delete process.env.AUTH_JWT_ISSUER;
  vi.unstubAllGlobals();
});

// Parse the JSON stash out of a bridge Set-Cookie string the way a browser→server round-trip would.
function readStash(setCookie: string): { v: string; s: string; r: string } {
  const raw = setCookie.slice(setCookie.indexOf('=') + 1, setCookie.indexOf(';'));
  return JSON.parse(decodeURIComponent(raw));
}

describe('buildAuthorizeRedirect', () => {
  it('builds the hub authorize URL with the derived client_id + exact redirect_uri + PKCE/state', () => {
    const { location, setCookie } = buildAuthorizeRedirect({
      selfOrigin: SELF,
      returnUrl: '/cases/7',
    });
    const url = new URL(location);
    expect(url.origin + url.pathname).toBe(`${HUB}/api/auth/oauth/authorize`);
    expect(url.searchParams.get('client_id')).toBe(firstPartyClientId(SELF));
    expect(url.searchParams.get('redirect_uri')).toBe(`${SELF}/api/auth/callback`);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('state')).toBeTruthy();

    // The bridge cookie stashes the verifier + state + returnUrl, and state matches the URL's state.
    const stash = readStash(setCookie);
    expect(stash.s).toBe(url.searchParams.get('state'));
    expect(stash.v).toBeTruthy();
    expect(stash.r).toBe('/cases/7');
    expect(setCookie).toContain(`${OAUTH_BRIDGE_COOKIE}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure'); // https issuer
    expect(setCookie).toContain('Path=/api/auth/callback');
  });

  it('collapses an unsafe returnUrl to /', () => {
    const { setCookie } = buildAuthorizeRedirect({
      selfOrigin: SELF,
      returnUrl: 'https://evil.com',
    });
    expect(readStash(setCookie).r).toBe('/');
  });

  it('throws when the hub is not configured', () => {
    h.loadAuthEnv.mockReturnValue({});
    expect(() => buildAuthorizeRedirect({ selfOrigin: SELF })).toThrow(/hub not configured/);
  });
});

describe('completeFirstPartyCallback', () => {
  const stashCookie = (v: string, s: string, r = '/dash') => JSON.stringify({ v, s, r });

  it('exchanges the code at the hub /session endpoint and returns the token + returnUrl + deviceId', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      json: async () => ({ token: 'civ.jwt', deviceId: 'dev-123' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await completeFirstPartyCallback({
      selfOrigin: SELF,
      query: { code: 'abc', state: 'st8' },
      bridgeCookieValue: stashCookie('verif', 'st8', '/dash'),
    });
    // deviceId rides back so the spoke can set the SHARED family device id as its own civ-device.
    expect(result).toEqual({ token: 'civ.jwt', returnUrl: '/dash', deviceId: 'dev-123' });

    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(`${HUB}/api/auth/oauth/session`);
    expect(JSON.parse(String(init.body))).toEqual({
      code: 'abc',
      code_verifier: 'verif',
      client_id: firstPartyClientId(SELF),
    });
  });

  it('forwards x-forwarded-for: <clientIp> on the session exchange when clientIp is provided', async () => {
    // So the hub rate-limits on the real end user AND, under internal routing (no proxy → no XFF), so the hub's
    // getClientAddress() has a header to resolve instead of 500ing the exchange.
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      json: async () => ({ token: 'civ.jwt', deviceId: 'dev-123' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await completeFirstPartyCallback({
      selfOrigin: SELF,
      query: { code: 'abc', state: 'st8' },
      bridgeCookieValue: stashCookie('verif', 'st8', '/dash'),
      clientIp: '198.51.100.7',
    });

    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-forwarded-for']).toBe('198.51.100.7');
    expect(headers['content-type']).toBe('application/json'); // preserved alongside the forwarded IP
  });

  it('OMITS x-forwarded-for when no clientIp is provided (public-routing behavior unchanged)', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      json: async () => ({ token: 'civ.jwt' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await completeFirstPartyCallback({
      selfOrigin: SELF,
      query: { code: 'abc', state: 'st8' },
      bridgeCookieValue: stashCookie('verif', 'st8', '/dash'),
    });

    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect('x-forwarded-for' in headers).toBe(false);
    expect(headers['content-type']).toBe('application/json');
  });

  it('rejects a state mismatch (CSRF) without calling the hub', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await completeFirstPartyCallback({
      selfOrigin: SELF,
      query: { code: 'abc', state: 'WRONG' },
      bridgeCookieValue: stashCookie('verif', 'st8'),
    });
    expect(result).toEqual({ error: 'oauth_state', returnUrl: '/dash' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces the hub error param', async () => {
    const result = await completeFirstPartyCallback({
      selfOrigin: SELF,
      query: { error: 'access_denied' },
      bridgeCookieValue: stashCookie('verif', 'st8'),
    });
    expect(result).toEqual({ error: 'access_denied', returnUrl: '/dash' });
  });

  it('returns oauth_exchange when the hub declines the code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, json: async () => ({}) }))
    );
    const result = await completeFirstPartyCallback({
      selfOrigin: SELF,
      query: { code: 'abc', state: 'st8' },
      bridgeCookieValue: stashCookie('verif', 'st8'),
    });
    expect(result).toEqual({ error: 'oauth_exchange', returnUrl: '/dash' });
  });

  it('treats a malformed/missing bridge cookie as a state failure', async () => {
    const result = await completeFirstPartyCallback({
      selfOrigin: SELF,
      query: { code: 'abc', state: 'st8' },
      bridgeCookieValue: 'not json',
    });
    expect(result).toEqual({ error: 'oauth_state', returnUrl: '/' });
  });
});

describe('helpers', () => {
  it('safePath rejects absolute + protocol-relative + backslash-prefixed', () => {
    expect(safePath('/ok')).toBe('/ok');
    expect(safePath('//evil.com')).toBe('/');
    expect(safePath('/\\evil.com')).toBe('/'); // `\`→`/` normalization → protocol-relative
    expect(safePath('/\\/evil.com')).toBe('/');
    expect(safePath('https://evil.com')).toBe('/');
    expect(safePath(undefined)).toBe('/');
  });
  it('generatePkce produces a verifier whose S256 challenge is returned', () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it('clearBridgeCookie expires the cookie', () => {
    expect(clearBridgeCookie(true)).toContain('Max-Age=0');
  });
});
