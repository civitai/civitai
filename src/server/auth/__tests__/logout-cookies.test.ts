import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Regression for finding M2: main-app logout must clear the device cookie (`civ-device`) that gates seamless
// multi-account switching — not just the session cookies. The device cookie is HttpOnly, so it can ONLY be
// cleared server-side here; leaving it lets the "switch back without re-login" set survive logout on a shared
// machine. We assert the buildLogoutCookies() header list covers the device cookie (both prefixes), alongside
// the session/legacy/orchestrator cookies it already cleared.

// generation.constants drags in the prisma-enums re-export shim (@civitai/db-schema/enums), which the unit
// project's resolver can't follow for that subpath export. Stub it — buildLogoutCookies only reads the
// orchestrator cookie NAME, so this keeps the rest of logout.ts (and the real @civitai/auth cookie helpers) real.
vi.mock('~/shared/constants/generation.constants', () => ({
  generationServiceCookie: { name: 'civitai-generation' },
}));

// Pull the cookie-name helpers from the same source the handler uses, so the test tracks the real names.
import { sessionCookieName, deviceCookieName } from '@civitai/auth';
import { POST_LOGIN_MARKER } from '../civ-cookie';

describe('buildLogoutCookies', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    delete process.env.AUTH_COOKIE_DOMAIN;
    delete process.env.NEXTAUTH_COOKIE_DOMAIN;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  // A cookie is "cleared" iff there's a Set-Cookie entry that names it AND expires it (Max-Age=0).
  const clears = (headers: string[], name: string) =>
    headers.some((h) => h.startsWith(`${name}=;`) && /Max-Age=0/i.test(h));

  it('clears the device cookie (both secure + non-secure prefixes)', async () => {
    const { buildLogoutCookies } = await import('../../../pages/api/auth/logout');
    const headers = buildLogoutCookies(undefined);

    // The core M2 assertion: the device cookie is cleared under both prefixes.
    expect(clears(headers, deviceCookieName(false))).toBe(true);
    expect(clears(headers, deviceCookieName(true))).toBe(true);
  });

  it('still clears the session + legacy + orchestrator cookies', async () => {
    const { buildLogoutCookies } = await import('../../../pages/api/auth/logout');
    const headers = buildLogoutCookies(undefined);

    // hub session cookie — both prefixes
    expect(clears(headers, sessionCookieName(false))).toBe(true);
    expect(clears(headers, sessionCookieName(true))).toBe(true);
    // legacy next-auth session cookie — both prefixes
    expect(clears(headers, 'civitai-token')).toBe(true);
    expect(clears(headers, '__Secure-civitai-token')).toBe(true);
    // orchestrator service-auth cookie
    expect(headers.some((h) => /Max-Age=0/i.test(h) && h.includes('=;'))).toBe(true);
  });

  // Regression: logout MUST clear the post-login loop-recovery marker. Otherwise a logout-then-login within the
  // marker's 60s TTL leaves it set while civ-token is (correctly) gone, and /api/auth/authorize false-fires its
  // "cookie didn't stick" recovery — the "We couldn't sign you in" page on civitai.red.
  it('clears the post-login loop-recovery marker (civ_postlogin)', async () => {
    const { buildLogoutCookies } = await import('../../../pages/api/auth/logout');
    const headers = buildLogoutCookies(undefined);
    expect(clears(headers, POST_LOGIN_MARKER)).toBe(true);
  });

  it('also de-cruds the ancillary next-auth cookies (CSRF / callback-url / state / pkce / nonce)', async () => {
    const { buildLogoutCookies } = await import('../../../pages/api/auth/logout');
    const headers = buildLogoutCookies(undefined);

    // None authenticate, but logout should fully de-crud the browser. Both dev + secure-prefixed names.
    for (const name of [
      '__Host-next-auth.csrf-token',
      '__Secure-next-auth.callback-url',
      '__Secure-next-auth.state',
      '__Secure-next-auth.pkce.code_verifier',
      '__Secure-next-auth.nonce',
    ]) {
      expect(clears(headers, name)).toBe(true);
    }
  });

  // Regression for the preview/staging logout bug: on a SUBDOMAIN host (e.g. stage.civitai.com) the spoke sets
  // civ-token/civ-device with Domain=civitai.com (the REGISTRABLE domain, via cookieDomainForHost). The old
  // logout cleared over `.{full-host}` (`.stage.civitai.com`) — which does NOT match `civitai.com` — so the
  // cookies survived sign-out. Assert we now clear the session AND device cookies over the registrable domain.
  it('clears the session + device cookies over the registrable domain on a subdomain host', async () => {
    const { buildLogoutCookies } = await import('../../../pages/api/auth/logout');
    const headers = buildLogoutCookies('stage.civitai.com');

    // civ-token + civ-device, plus the legacy session cookie (clearLegacyCookies now also scopes to the
    // registrable domain — the old `.{full-host}` parent orphaned it on a subdomain logout host too).
    for (const name of [
      sessionCookieName(true),
      deviceCookieName(true),
      '__Secure-civitai-token',
    ]) {
      const scoped = headers.filter((h) => h.startsWith(`${name}=;`));
      // The fix: a clear scoped to the registrable domain the cookie was actually set with.
      expect(scoped.some((h) => h.includes('Domain=civitai.com'))).toBe(true);
      // Defensive host-only fallback still emitted.
      expect(scoped.some((h) => !/Domain=/.test(h))).toBe(true);
    }
  });

  // The main app must NEVER read AUTH_COOKIE_DOMAIN — it's a HUB-only env var, and honoring it on the
  // multi-color main app is what broke civitai.red (a `.civitai.com` value can't scope a `.red` host, so the
  // session cookie never landed AND the cross-site-logout registrable check fell back to host-only). Even with
  // the var set, the cleared Domains must be ONLY host-only + the host-derived registrable. No coverage is lost:
  // the hub-set `.civitai.com` device cookie is still cleared by the registrable `civitai.com` (RFC 6265 treats
  // the leading dot as the same scope).
  it('IGNORES AUTH_COOKIE_DOMAIN — never scopes a clear to the hub env var', async () => {
    process.env.AUTH_COOKIE_DOMAIN = '.civitai.red';
    vi.resetModules();
    const { buildLogoutCookies } = await import('../../../pages/api/auth/logout');
    const headers = buildLogoutCookies('civitai.com');

    // No Set-Cookie may carry the override value.
    expect(headers.some((h) => h.includes('Domain=.civitai.red'))).toBe(false);
    // civ-token + civ-device are cleared over the derived registrable (civitai.com) AND host-only.
    for (const name of [sessionCookieName(true), deviceCookieName(true)]) {
      const scoped = headers.filter((h) => h.startsWith(`${name}=;`));
      expect(scoped.some((h) => h.includes('Domain=civitai.com'))).toBe(true);
      expect(scoped.some((h) => !/Domain=/.test(h))).toBe(true);
    }
  });
});
