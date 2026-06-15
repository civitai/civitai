import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Zero-config: the hub URL comes from env. Mock it + stub fetch like the other client tests.
const h = vi.hoisted(() => ({ loadAuthEnv: vi.fn() }));
vi.mock('../env', () => ({ loadAuthEnv: h.loadAuthEnv }));

import { createSessionTokenClient } from '../session-token-client';

type Res = { ok: boolean; status: number; json: () => Promise<unknown> };
function stubFetch(impl: (url: string, init: { method?: string; headers: Record<string, string> }) => Promise<Res>) {
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
});
