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

  // Regression for the preview/staging logout bug: on a SUBDOMAIN host (e.g. stage.civitai.com) the spoke sets
  // civ-token/civ-device with Domain=civitai.com (the REGISTRABLE domain, via cookieDomainForHost). The old
  // logout cleared over `.{full-host}` (`.stage.civitai.com`) — which does NOT match `civitai.com` — so the
  // cookies survived sign-out. Assert we now clear the session AND device cookies over the registrable domain.
  it('clears the session + device cookies over the registrable domain on a subdomain host', async () => {
    const { buildLogoutCookies } = await import('../../../pages/api/auth/logout');
    const headers = buildLogoutCookies('stage.civitai.com');

    for (const name of [sessionCookieName(true), deviceCookieName(true)]) {
      const scoped = headers.filter((h) => h.startsWith(`${name}=;`));
      // The fix: a clear scoped to the registrable domain the cookie was actually set with.
      expect(scoped.some((h) => h.includes('Domain=civitai.com'))).toBe(true);
      // Defensive host-only fallback still emitted.
      expect(scoped.some((h) => !/Domain=/.test(h))).toBe(true);
    }
  });

  // The HUB sets the device cookie with Domain=AUTH_COOKIE_DOMAIN (apps/auth/.../device.ts cookieOpts). On a
  // single-color env where that override is set, a logout that didn't clear over that exact Domain would orphan
  // the device cookie. Assert buildLogoutCookies picks up AUTH_COOKIE_DOMAIN for the device cookie too.
  it('clears the device cookie over AUTH_COOKIE_DOMAIN when the override is set', async () => {
    process.env.AUTH_COOKIE_DOMAIN = '.civitai.red';
    vi.resetModules();
    const { buildLogoutCookies } = await import('../../../pages/api/auth/logout');
    const headers = buildLogoutCookies(undefined);

    const deviceHeaders = headers.filter((h) => h.startsWith(`${deviceCookieName(true)}=;`));
    expect(deviceHeaders.some((h) => h.includes('Domain=.civitai.red'))).toBe(true);
    // ...and it must still emit a host-only (Domain-less) clear as the defensive fallback.
    expect(
      headers.some((h) => h.startsWith(`${deviceCookieName(true)}=;`) && !/Domain=/.test(h))
    ).toBe(true);
  });
});
