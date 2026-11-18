import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ loadAuthEnv: vi.fn() }));
vi.mock('../env', () => ({ loadAuthEnv: h.loadAuthEnv }));

import { legacyCookieReadEnabled, sessionCookieMode, siteCookieHeader } from '../cookies';
import { createDeviceAccountClient } from '../device-client';
import { refreshInternalParity } from '../hub';
import { createImpersonationClient } from '../impersonation-client';

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  process.env.AUTH_JWT_ISSUER = 'https://auth.civitai.com';
  process.env.AUTH_SESSION_COOKIE_MODE = 'shared';
  process.env.AUTH_SESSION_COOKIE_MODE_BY_SITE = 'civitai.red:host';
  delete process.env.AUTH_LEGACY_READ;
  delete process.env.NEXT_PUBLIC_BASE_URL;
  h.loadAuthEnv.mockReturnValue({ AUTH_JWT_ISSUER: 'https://auth.test' });
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

describe('AUTH_SESSION_COOKIE_MODE_BY_SITE', () => {
  it('gives a listed site its own mode, by registrable domain, and leaves other sites on the global mode', () => {
    for (const host of ['civitai.red', 'www.civitai.red', 'CIVITAI.RED:443']) {
      expect(sessionCookieMode(host)).toBe('host');
      expect(legacyCookieReadEnabled(host)).toBe(false);
    }
    for (const host of ['civitai.com', 'auth.civitai.com', undefined, null]) {
      expect(sessionCookieMode(host)).toBe('shared');
      expect(legacyCookieReadEnabled(host)).toBe(true);
    }
  });

  it('ignores an entry whose mode is not exactly host or shared', () => {
    process.env.AUTH_SESSION_COOKIE_MODE_BY_SITE = 'civitai.red:Host, civitai.com:hots';
    expect(sessionCookieMode('civitai.red')).toBe('shared');
    expect(legacyCookieReadEnabled('civitai.red')).toBe(true);
  });
});

describe('forwarding a host-only site’s cookies', () => {
  const header =
    '__Secure-civ-token=s; __Host-civ-token=h; __Secure-civ-device=sd; __Host-civ-device=hd; x=1';

  it('drops the shared slot on civitai.red only', () => {
    expect(siteCookieHeader(header, 'civitai.red')).toBe(
      '__Host-civ-token=h; __Host-civ-device=hd; x=1'
    );
    expect(siteCookieHeader(header, 'civitai.com')).toBe(header);
  });

  it('the device client sends the hub the host-only session and device on civitai.red', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ token: 't' }),
    }));
    vi.stubGlobal('fetch', fetch);
    await createDeviceAccountClient().switch(header, 2, 'civitai.red');
    const [, init] = fetch.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> }
    ];
    expect(init.headers.cookie).toBe('__Host-civ-token=h; __Host-civ-device=hd; x=1');
  });

  it('impersonation sends the hub the host-only session on civitai.red', async () => {
    // The hub accepts this app's internal credential, so the session travels in the body.
    const fetch = vi.fn(async (url: string) =>
      url.endsWith('/internal-ping')
        ? { ok: true, status: 204, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ token: 't' }) }
    );
    vi.stubGlobal('fetch', fetch);
    h.loadAuthEnv.mockReturnValue({
      AUTH_JWT_ISSUER: 'https://auth.test',
      AUTH_INTERNAL_TOKEN: 'i',
    });
    await refreshInternalParity();
    await createImpersonationClient().impersonate(header, 2, 'civitai.red');
    const [, init] = fetch.mock.calls.at(-1) as unknown as [string, { body: string }];
    expect(JSON.parse(init.body).token).toBe('h');
    h.loadAuthEnv.mockReturnValue({ AUTH_JWT_ISSUER: 'https://auth.test' });
    await refreshInternalParity();
  });
});
