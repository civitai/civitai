import { describe, it, expect } from 'vitest';
import {
  cookieDomainForHost,
  postLoginMarkerCookie,
  clearAllSessionCookies,
  POST_LOGIN_MARKER,
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

    // The one-shot marker is cleared as part of recovery.
    expect(cleared.some((c) => c.startsWith(`${POST_LOGIN_MARKER}=`) && has(c, 'Max-Age=0'))).toBe(
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
