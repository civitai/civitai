import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Zero-config: the hub URL comes from env. Mock it + stub fetch like the other client tests.
const h = vi.hoisted(() => ({ loadAuthEnv: vi.fn() }));
vi.mock('../env', () => ({ loadAuthEnv: h.loadAuthEnv }));

import { createSessionTokenClient } from '../session-token-client';

type Res = { ok: boolean; status: number; json: () => Promise<unknown> };
function stubFetch(
  impl: (
    url: string,
    init: { method?: string; headers: Record<string, string>; body?: string }
  ) => Promise<Res>
) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  h.loadAuthEnv.mockReturnValue({ AUTH_JWT_ISSUER: 'https://auth.test' });
});
afterEach(() => vi.unstubAllGlobals());

describe('createSessionTokenClient', () => {
  it('refresh posts the bearer token and returns the fresh token', async () => {
    const fetch = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ token: 'fresh.jwt' }) }));
    expect(await createSessionTokenClient().refresh('cur.jwt')).toEqual({ token: 'fresh.jwt' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://auth.test/api/auth/refresh');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer cur.jwt');
  });

  it('refresh forwards the device cookie when given', async () => {
    const fetch = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ token: 'x' }) }));
    await createSessionTokenClient().refresh('cur', { deviceCookie: 'dev-123' });
    const [, init] = fetch.mock.calls[0];
    expect(init.headers.cookie).toContain('dev-123');
  });

  it('refresh returns null when the hub declines', async () => {
    stubFetch(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    expect(await createSessionTokenClient().refresh('cur')).toBeNull();
  });

  it('revoke posts the token cookie to the hub logout', async () => {
    const fetch = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    await createSessionTokenClient().revoke('tok');
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://auth.test/logout');
    expect(init.headers.cookie).toContain('tok');
  });

  it('revoke never throws on a hub blip', async () => {
    stubFetch(async () => {
      throw new Error('down');
    });
    await expect(createSessionTokenClient().revoke('tok')).resolves.toBeUndefined();
  });

  it('no-ops (no fetch) when AUTH_JWT_ISSUER is unset', async () => {
    h.loadAuthEnv.mockReturnValue({});
    const fetch = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    expect(await createSessionTokenClient().refresh('cur')).toBeNull();
    await createSessionTokenClient().revoke('tok');
    expect(fetch).not.toHaveBeenCalled();
  });

  describe('exchangeLegacy', () => {
    beforeEach(() => {
      h.loadAuthEnv.mockReturnValue({
        AUTH_JWT_ISSUER: 'https://auth.test',
        AUTH_INTERNAL_TOKEN: 'svc-secret',
      });
    });

    it('posts the legacy token under the service-secret bearer and returns the fresh civ-token', async () => {
      const fetch = stubFetch(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ token: 'civ.jwt' }),
      }));
      expect(await createSessionTokenClient().exchangeLegacy('legacy.jwe')).toEqual({
        token: 'civ.jwt',
      });
      const [url, init] = fetch.mock.calls[0];
      expect(url).toBe('https://auth.test/api/auth/oauth/legacy-exchange');
      expect(init.method).toBe('POST');
      // Service secret authenticates the CALLER; the legacy cookie (in the body) proves WHO.
      expect(init.headers.authorization).toBe('Bearer svc-secret');
      expect(JSON.parse(init.body ?? '{}')).toEqual({ legacyToken: 'legacy.jwe' });
    });

    it('returns null (no fetch) when AUTH_INTERNAL_TOKEN is unset', async () => {
      h.loadAuthEnv.mockReturnValue({ AUTH_JWT_ISSUER: 'https://auth.test' });
      const fetch = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({}) }));
      expect(await createSessionTokenClient().exchangeLegacy('legacy.jwe')).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    });

    it('returns null when the hub declines', async () => {
      stubFetch(async () => ({ ok: false, status: 401, json: async () => ({}) }));
      expect(await createSessionTokenClient().exchangeLegacy('legacy.jwe')).toBeNull();
    });

    it('returns null (never throws) on a hub blip', async () => {
      stubFetch(async () => {
        throw new Error('down');
      });
      await expect(createSessionTokenClient().exchangeLegacy('legacy.jwe')).resolves.toBeNull();
    });

    it('returns null for an empty token without fetching', async () => {
      const fetch = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({}) }));
      expect(await createSessionTokenClient().exchangeLegacy('')).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
