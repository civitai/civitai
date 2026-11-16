import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ loadAuthEnv: vi.fn() }));
vi.mock('../env', () => ({ loadAuthEnv: h.loadAuthEnv }));

import {
  buildAuthorizeRedirect,
  completeFirstPartyCallback,
  clearBridgeCookie,
  safePath,
  generatePkce,
  bridgeCookieName,
  OAUTH_BRIDGE_COOKIE,
} from '../first-party-bridge';
import { firstPartyClientId } from '../first-party';
import { SAFE_RETURN_PATHS, UNSAFE_RETURN_PATHS } from './return-path-cases';

const HUB = 'https://auth.test';
const SELF = 'https://moderator.civitai.com';
// States in randomState()'s shape (32 base64url chars): only that shape names a bridge cookie.
const ST8 = 'st8'.padEnd(32, 'x');
const OTHER = 'other'.padEnd(32, 'y');
const flow = (value: string, state = ST8) => ({ [bridgeCookieName(state)]: value });

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
    const {
      location,
      setCookies: [setCookie],
    } = buildAuthorizeRedirect({
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
    expect(setCookie).toContain(`${bridgeCookieName(url.searchParams.get('state')!)}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure'); // https issuer
    expect(setCookie).toContain('Path=/api/auth/callback');
  });

  it('sets SameSite=None; Secure so the cookie survives the cross-site OAuth round-trip', () => {
    // https issuer → secure → the cross-registrable-domain (.red) return needs None; Lax was dropped there.
    const {
      setCookies: [setCookie],
    } = buildAuthorizeRedirect({ selfOrigin: SELF, returnUrl: '/x' });
    expect(setCookie).toContain('SameSite=None');
    expect(setCookie).toContain('Secure');
    expect(setCookie).not.toContain('SameSite=Lax');
  });

  it('falls back to SameSite=Lax (no Secure) when the cookie is not Secure (dev/http)', () => {
    // None REQUIRES Secure — a None cookie without Secure is rejected by browsers, so http/dev uses Lax.
    const {
      setCookies: [setCookie],
    } = buildAuthorizeRedirect({
      selfOrigin: SELF,
      returnUrl: '/x',
      secure: false,
    });
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toContain('SameSite=None');
    expect(setCookie).not.toContain('Secure');
  });

  it('adds Domain=<registrable> when cookieDomain is given (survives www↔apex host variation)', () => {
    const {
      setCookies: [setCookie],
    } = buildAuthorizeRedirect({
      selfOrigin: SELF,
      returnUrl: '/x',
      cookieDomain: 'civitai.red',
    });
    expect(setCookie).toContain('Domain=civitai.red');
  });

  it('omits Domain (host-only) when no cookieDomain is given', () => {
    const {
      setCookies: [setCookie],
    } = buildAuthorizeRedirect({ selfOrigin: SELF, returnUrl: '/x' });
    expect(setCookie).not.toContain('Domain=');
  });

  it('collapses an unsafe returnUrl to /', () => {
    const {
      setCookies: [setCookie],
    } = buildAuthorizeRedirect({
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
      query: { code: 'abc', state: ST8 },
      cookies: flow(stashCookie('verif', ST8, '/dash')),
    });
    // deviceId rides back so the spoke can set the SHARED family device id as its own civ-device.
    expect(result).toEqual({
      clearCookies: expect.any(Array),
      token: 'civ.jwt',
      returnUrl: '/dash',
      deviceId: 'dev-123',
    });

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
      query: { code: 'abc', state: ST8 },
      cookies: flow(stashCookie('verif', ST8, '/dash')),
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
      query: { code: 'abc', state: ST8 },
      cookies: flow(stashCookie('verif', ST8, '/dash')),
    });

    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect('x-forwarded-for' in headers).toBe(false);
    expect(headers['content-type']).toBe('application/json');
  });

  it('rejects a state mismatch (CSRF) without calling the hub — detail: state_mismatch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await completeFirstPartyCallback({
      selfOrigin: SELF,
      query: { code: 'abc', state: OTHER },
      cookies: flow(stashCookie('verif', ST8)),
    });
    // Another flow's stash is no match for this state, and is left for its own callback.
    expect(result).toEqual({
      clearCookies: [],
      error: 'oauth_state',
      returnUrl: '/',
      detail: 'state_mismatch',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('flags a missing code/state as detail: no_code (hub-side, not the cookie)', async () => {
    const result = await completeFirstPartyCallback({
      selfOrigin: SELF,
      query: { code: 'abc' }, // no state echoed back
      cookies: flow(stashCookie('verif', ST8)),
    });
    expect(result).toEqual({
      clearCookies: expect.any(Array),
      error: 'oauth_state',
      returnUrl: '/',
      detail: 'no_code',
    });
  });

  it('surfaces the hub error param', async () => {
    const result = await completeFirstPartyCallback({
      selfOrigin: SELF,
      query: { error: 'access_denied', state: ST8 },
      cookies: flow(stashCookie('verif', ST8)),
    });
    expect(result).toEqual({
      clearCookies: expect.any(Array),
      error: 'access_denied',
      returnUrl: '/dash',
    });
  });

  it('returns oauth_exchange (detail: declined) when the hub rejects the code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, json: async () => ({}) }))
    );
    const result = await completeFirstPartyCallback({
      selfOrigin: SELF,
      query: { code: 'abc', state: ST8 },
      cookies: flow(stashCookie('verif', ST8)),
    });
    expect(result).toEqual({
      clearCookies: expect.any(Array),
      error: 'oauth_exchange',
      returnUrl: '/dash',
      detail: 'declined',
    });
  });

  it('returns oauth_exchange (detail: network) when the hub fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('hub unreachable');
      })
    );
    const result = await completeFirstPartyCallback({
      selfOrigin: SELF,
      query: { code: 'abc', state: ST8 },
      cookies: flow(stashCookie('verif', ST8)),
    });
    expect(result).toEqual({
      clearCookies: expect.any(Array),
      error: 'oauth_exchange',
      returnUrl: '/dash',
      detail: 'network',
    });
  });

  it('treats a malformed bridge cookie as detail: no_cookie (as if it never arrived)', async () => {
    const result = await completeFirstPartyCallback({
      selfOrigin: SELF,
      query: { code: 'abc', state: ST8 },
      cookies: flow('not json'),
    });
    expect(result).toEqual({
      clearCookies: expect.any(Array),
      error: 'oauth_state',
      returnUrl: '/',
      detail: 'no_cookie',
    });
  });
});

describe('completeFirstPartyCallback: one stash per flow', () => {
  const stash = (s: string, r = '/dash') => JSON.stringify({ v: `verif-${s}`, s, r });
  const okHub = () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      json: async () => ({ token: 'civ.jwt' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };
  const sentVerifier = (fetchMock: ReturnType<typeof okHub>) =>
    JSON.parse(String(fetchMock.mock.calls[0][1].body)).code_verifier;

  it('uses and clears only the stash named for the returned state', async () => {
    const fetchMock = okHub();
    const result = await completeFirstPartyCallback({
      selfOrigin: SELF,
      query: { code: 'abc', state: ST8 },
      cookies: { ...flow(stash(ST8, '/mine')), ...flow(stash(OTHER, '/theirs'), OTHER) },
      cookieDomain: 'civitai.red',
    });
    expect(result).toMatchObject({ token: 'civ.jwt', returnUrl: '/mine' });
    expect(sentVerifier(fetchMock)).toBe(`verif-${ST8}`);
    expect(result.clearCookies).toEqual([
      clearBridgeCookie(true, 'civitai.red', bridgeCookieName(ST8)),
    ]);
  });

  it('rejects a stash whose name matches the state but whose content does not', async () => {
    const fetchMock = okHub();
    const result = await completeFirstPartyCallback({
      selfOrigin: SELF,
      query: { code: 'abc', state: ST8 },
      cookies: flow(stash(OTHER)),
    });
    expect(result).toMatchObject({
      error: 'oauth_state',
      detail: 'state_mismatch',
      returnUrl: '/',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.clearCookies).toEqual([
      clearBridgeCookie(true, undefined, bridgeCookieName(ST8)),
    ]);
  });

  it('rejects a stash for this state that carries no verifier', async () => {
    const fetchMock = okHub();
    const result = await completeFirstPartyCallback({
      selfOrigin: SELF,
      query: { code: 'abc', state: ST8 },
      cookies: flow(JSON.stringify({ s: ST8, r: '/dash' })),
    });
    expect(result).toMatchObject({ error: 'oauth_state' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['too short', 'abc'],
    ['a character outside base64url', `${'a'.repeat(31)};`],
    ['too long', 'a'.repeat(33)],
  ])('a state that is %s names no cookie, even one holding that state', async (_name, state) => {
    const fetchMock = okHub();
    const result = await completeFirstPartyCallback({
      selfOrigin: SELF,
      query: { code: 'abc', state },
      cookies: { [bridgeCookieName(state)]: stash(state) },
    });
    expect(result).toMatchObject({ error: 'oauth_state', clearCookies: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a stash under the pre-per-flow name only when it holds this state', async () => {
    const fetchMock = okHub();
    const ok = await completeFirstPartyCallback({
      selfOrigin: SELF,
      query: { code: 'abc', state: ST8 },
      cookies: { [OAUTH_BRIDGE_COOKIE]: stash(ST8) },
    });
    expect(ok).toMatchObject({ token: 'civ.jwt', returnUrl: '/dash' });
    expect(sentVerifier(fetchMock)).toBe(`verif-${ST8}`);
    expect(ok.clearCookies).toEqual([clearBridgeCookie(true)]);

    fetchMock.mockClear();
    const other = await completeFirstPartyCallback({
      selfOrigin: SELF,
      query: { code: 'abc', state: ST8 },
      cookies: { [OAUTH_BRIDGE_COOKIE]: stash(OTHER) },
    });
    expect(other).toMatchObject({
      error: 'oauth_state',
      detail: 'no_cookie',
      clearCookies: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('authorize writes the same stash under the per-flow and the pre-per-flow name, each for 10 minutes', () => {
    const { location, setCookies } = buildAuthorizeRedirect({ selfOrigin: SELF, returnUrl: '/x' });
    const state = new URL(location).searchParams.get('state')!;
    expect(state).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const [perFlow, legacy] = setCookies;
    expect(perFlow.startsWith(`${bridgeCookieName(state)}=`)).toBe(true);
    expect(legacy.startsWith(`${OAUTH_BRIDGE_COOKIE}=`)).toBe(true);
    expect(readStash(legacy)).toEqual(readStash(perFlow));
    for (const c of setCookies) {
      expect(c).toContain('Max-Age=600');
      expect(c).toContain('Path=/api/auth/callback');
    }
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
  it.each(UNSAFE_RETURN_PATHS)('safePath falls back to / for: %s', (_name, raw) => {
    expect(safePath(raw)).toBe('/');
  });
  it.each(SAFE_RETURN_PATHS)('safePath keeps: %s', (_name, raw, expected) => {
    expect(safePath(raw)).toBe(expected);
  });
  it.each(UNSAFE_RETURN_PATHS)('buildAuthorizeRedirect stashes / for: %s', (_name, raw) => {
    const {
      setCookies: [setCookie],
    } = buildAuthorizeRedirect({ selfOrigin: SELF, returnUrl: raw });
    expect(readStash(setCookie).r).toBe('/');
  });
  it.each(UNSAFE_RETURN_PATHS)(
    'completeFirstPartyCallback returns / for a stashed: %s',
    async (_name, raw) => {
      const result = await completeFirstPartyCallback({
        selfOrigin: SELF,
        query: { error: 'access_denied', state: ST8 },
        cookies: flow(JSON.stringify({ v: 'verif', s: ST8, r: raw })),
      });
      expect(result).toEqual({
        clearCookies: expect.any(Array),
        error: 'access_denied',
        returnUrl: '/',
      });
    }
  );
  it('generatePkce produces a verifier whose S256 challenge is returned', () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it('clearBridgeCookie expires the cookie', () => {
    expect(clearBridgeCookie(true)).toContain('Max-Age=0');
  });
});
