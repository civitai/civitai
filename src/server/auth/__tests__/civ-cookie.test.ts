import { describe, it, expect } from 'vitest';
import {
  cookieDomainForHost,
  postLoginMarkerCookie,
  clearAllSessionCookies,
  clearLegacyCookies,
  POST_LOGIN_MARKER,
  LOGIN_RETRY_COOKIE,
  loginRetryCookie,
  clearLoginRetryCookie,
  clearPostLoginMarker,
  hasAnyLegacyCookie,
} from '../civ-cookie';

// Parse a Set-Cookie string into trimmed attribute tokens for order-independent assertions.
const attrs = (cookie: string) => cookie.split(';').map((s) => s.trim());
const has = (cookie: string, attr: string) =>
  attrs(cookie).some((a) => a.toLowerCase() === attr.toLowerCase());
const domainOf = (cookie: string) =>
  attrs(cookie)
    .find((a) => a.toLowerCase().startsWith('domain='))
    ?.slice('domain='.length);

describe('cookieDomainForHost — registrable-domain derivation + suffix guard', () => {
  it('derives the registrable (2-label) domain for a subdomain host', () => {
    expect(cookieDomainForHost('advertising.civitai.com')).toBe('civitai.com');
    expect(cookieDomainForHost('test-auth.civitai.red')).toBe('civitai.red');
    // The preview wildcard zone: an ephemeral PR host still resolves to civitaic.com.
    expect(cookieDomainForHost('pr-2468.civitaic.com')).toBe('civitaic.com');
  });

  it('returns the apex itself for a 2-label host', () => {
    expect(cookieDomainForHost('civitai.com')).toBe('civitai.com');
    expect(cookieDomainForHost('civitai.red')).toBe('civitai.red');
  });

  it('strips a port before deriving', () => {
    expect(cookieDomainForHost('civitai.com:3000')).toBe('civitai.com');
  });

  it('falls back to host-only (undefined) for localhost / IP / unusable hosts', () => {
    expect(cookieDomainForHost('localhost')).toBeUndefined();
    expect(cookieDomainForHost('localhost:3000')).toBeUndefined();
    expect(cookieDomainForHost('127.0.0.1')).toBeUndefined();
    expect(cookieDomainForHost('')).toBeUndefined();
    expect(cookieDomainForHost(undefined)).toBeUndefined();
  });
});

describe('postLoginMarkerCookie — one-shot loop probe', () => {
  const cookie = postLoginMarkerCookie();

  it('sets the marker with a short TTL', () => {
    expect(cookie.startsWith(`${POST_LOGIN_MARKER}=1`)).toBe(true);
    expect(has(cookie, 'Max-Age=60')).toBe(true);
    expect(has(cookie, 'Path=/')).toBe(true);
  });

  it('is host-only and NOT secure so it lands regardless of the session cookie', () => {
    expect(domainOf(cookie)).toBeUndefined(); // host-only — no Domain
    expect(has(cookie, 'Secure')).toBe(false); // non-secure so it sticks even when the real cookie cannot
    expect(has(cookie, 'HttpOnly')).toBe(true);
    expect(has(cookie, 'SameSite=Lax')).toBe(true);
  });
});

describe('clearAllSessionCookies — cross-scope session-cookie wipe', () => {
  it('expires civ-token at host-only AND the registrable domain, plus the marker', () => {
    const cleared = clearAllSessionCookies('advertising.civitai.com');

    // Every entry is an expiry.
    expect(cleared.every((c) => has(c, 'Max-Age=0'))).toBe(true);

    // civ-token cleared host-only (no Domain) and at the registrable domain.
    const civ = cleared.filter((c) => c.startsWith('civ-token='));
    expect(civ.some((c) => domainOf(c) === undefined)).toBe(true);
    expect(civ.some((c) => domainOf(c) === 'civitai.com')).toBe(true);

    // The __Secure- variant is cleared too, and carries the Secure attribute (required to clear it).
    const secure = cleared.filter((c) => c.startsWith('__Secure-civ-token='));
    expect(secure.length).toBeGreaterThan(0);
    expect(secure.every((c) => has(c, 'Secure'))).toBe(true);
    expect(secure.some((c) => domainOf(c) === 'civitai.com')).toBe(true);

    // The one-shot marker AND the login-retry counter are cleared as part of recovery.
    expect(cleared.some((c) => c.startsWith(`${POST_LOGIN_MARKER}=`) && has(c, 'Max-Age=0'))).toBe(
      true
    );
    expect(cleared.some((c) => c.startsWith(`${LOGIN_RETRY_COOKIE}=`) && has(c, 'Max-Age=0'))).toBe(
      true
    );
  });

  it('clears only host-only scopes on localhost (no Domain emitted)', () => {
    const cleared = clearAllSessionCookies('localhost');
    expect(cleared.every((c) => domainOf(c) === undefined)).toBe(true);
    // Still both name prefixes + the marker.
    expect(cleared.some((c) => c.startsWith('civ-token='))).toBe(true);
    expect(cleared.some((c) => c.startsWith('__Secure-civ-token='))).toBe(true);
    expect(cleared.some((c) => c.startsWith(`${POST_LOGIN_MARKER}=`))).toBe(true);
  });
});

describe('login retry budget (retry-tolerant loop recovery)', () => {
  it('records the retry count host-only + non-secure so it always lands, short TTL', () => {
    const c = loginRetryCookie(1);
    expect(c.startsWith(`${LOGIN_RETRY_COOKIE}=1`)).toBe(true);
    expect(domainOf(c)).toBeUndefined(); // host-only
    expect(has(c, 'Secure')).toBe(false); // lands regardless of the session cookie's fate
    expect(has(c, 'HttpOnly')).toBe(true);
    expect(has(c, 'SameSite=Lax')).toBe(true);
    expect(c).toMatch(/Max-Age=\d+/);
  });

  it('clearLoginRetryCookie + clearPostLoginMarker expire host-only', () => {
    for (const c of [clearLoginRetryCookie(), clearPostLoginMarker()]) {
      expect(has(c, 'Max-Age=0')).toBe(true);
      expect(domainOf(c)).toBeUndefined();
    }
    expect(clearLoginRetryCookie().startsWith(`${LOGIN_RETRY_COOKIE}=;`)).toBe(true);
    expect(clearPostLoginMarker().startsWith(`${POST_LOGIN_MARKER}=;`)).toBe(true);
  });
});

describe('hasAnyLegacyCookie — gate the callback de-crud', () => {
  it('false when the browser carries no legacy next-auth cookie (common post-cutover login)', () => {
    expect(hasAnyLegacyCookie({})).toBe(false);
    expect(hasAnyLegacyCookie({ '__Secure-civ-token': 'x', civ_postlogin: '1' })).toBe(false);
  });

  it('true when any legacy next-auth cookie is present (returning pre-cutover user)', () => {
    expect(hasAnyLegacyCookie({ 'civitai-token': 'x' })).toBe(true);
    expect(hasAnyLegacyCookie({ '__Secure-civitai-token': 'x' })).toBe(true);
    expect(hasAnyLegacyCookie({ 'next-auth.state': 'x' })).toBe(true);
  });
});

describe('clearLegacyCookies — full legacy next-auth de-crud (session + ancillary)', () => {
  const cleared = clearLegacyCookies('civitai.com');
  const startsWith = (name: string) => cleared.filter((c) => c.startsWith(`${name}=;`));

  it('expires every legacy next-auth cookie (session + CSRF / callback-url / state / pkce / nonce, both prefixes)', () => {
    for (const name of [
      'civitai-token',
      '__Secure-civitai-token',
      'next-auth.csrf-token',
      '__Host-next-auth.csrf-token',
      'next-auth.callback-url',
      '__Secure-next-auth.callback-url',
      'next-auth.state',
      '__Secure-next-auth.state',
      'next-auth.pkce.code_verifier',
      '__Secure-next-auth.pkce.code_verifier',
      'next-auth.nonce',
      '__Secure-next-auth.nonce',
    ]) {
      expect(startsWith(name).length).toBeGreaterThan(0);
    }
    // Every entry is an expiry.
    expect(cleared.every((c) => has(c, 'Max-Age=0'))).toBe(true);
  });

  it('clears the legacy SESSION cookie across host-only AND the registrable domain (both prefixes)', () => {
    for (const name of ['civitai-token', '__Secure-civitai-token']) {
      const entries = startsWith(name);
      expect(entries.some((c) => domainOf(c) === undefined)).toBe(true); // host-only
      expect(entries.some((c) => domainOf(c) === 'civitai.com')).toBe(true); // registrable domain
    }
  });

  it('emits the `__Host-` CSRF clear host-only (no Domain) WITH Secure — else the browser rejects it', () => {
    const host = startsWith('__Host-next-auth.csrf-token');
    expect(host.length).toBe(1); // host-only only — never Domain-scoped
    expect(host.every((c) => domainOf(c) === undefined)).toBe(true);
    expect(host.every((c) => has(c, 'Secure'))).toBe(true);
  });

  it('clears the CSRF cookie host-only under both prefixes (next-auth set it host-only)', () => {
    expect(startsWith('next-auth.csrf-token').every((c) => domainOf(c) === undefined)).toBe(true);
  });

  it('every `__Secure-`/`__Host-` prefixed clear carries Secure; bare names never do', () => {
    for (const c of cleared) {
      const isPrefixed = c.startsWith('__Secure-') || c.startsWith('__Host-');
      expect(has(c, 'Secure')).toBe(isPrefixed);
    }
  });

  it('clears callback-url/state/pkce/nonce across host-only AND the registrable domain', () => {
    for (const name of [
      '__Secure-next-auth.callback-url',
      '__Secure-next-auth.state',
      '__Secure-next-auth.pkce.code_verifier',
      '__Secure-next-auth.nonce',
    ]) {
      const entries = startsWith(name);
      expect(entries.some((c) => domainOf(c) === undefined)).toBe(true); // host-only
      expect(entries.some((c) => domainOf(c) === 'civitai.com')).toBe(true); // registrable domain
    }
  });

  it('on localhost emits only host-only clears (no Domain)', () => {
    expect(clearLegacyCookies('localhost').every((c) => domainOf(c) === undefined)).toBe(true);
  });
});
