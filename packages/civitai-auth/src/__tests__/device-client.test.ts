import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Zero-config: the hub URL comes from env. Mock it (no injectable config) + stub fetch like session-client.
const h = vi.hoisted(() => ({ loadAuthEnv: vi.fn() }));
vi.mock('../env', () => ({ loadAuthEnv: h.loadAuthEnv }));

import { createDeviceAccountClient } from '../device-client';

type Res = { ok: boolean; status: number; json: () => Promise<unknown> };
function stubFetch(impl: (url: string, init: { method?: string; headers: Record<string, string>; body?: string }) => Promise<Res>) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  h.loadAuthEnv.mockReturnValue({ AUTH_JWT_ISSUER: 'https://auth.test' });
});
afterEach(() => vi.unstubAllGlobals());

describe('createDeviceAccountClient', () => {
  it('list forwards the cookie to the hub and returns the accounts', async () => {
    const fetch = stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ accounts: [{ userId: 7, active: true, lastSwitchedAt: 1 }] }),
    }));
    const accounts = await createDeviceAccountClient().list('civ-token=abc');
    expect(accounts).toEqual([{ userId: 7, active: true, lastSwitchedAt: 1 }]);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://auth.test/api/auth/accounts');
    expect(init.headers.cookie).toBe('civ-token=abc');
  });

  it('list returns [] on a non-ok response (unauthorized)', async () => {
    stubFetch(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    expect(await createDeviceAccountClient().list('x')).toEqual([]);
  });

  it('switch posts the userId and returns the minted token', async () => {
    const fetch = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ token: 'jwt.x.y' }) }));
    expect(await createDeviceAccountClient().switch('c=1', 9)).toEqual({ token: 'jwt.x.y' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://auth.test/api/auth/switch');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body ?? '{}')).toEqual({ userId: 9 });
  });

  it('switch returns null when the hub declines', async () => {
    stubFetch(async () => ({ ok: false, status: 403, json: async () => ({}) }));
    expect(await createDeviceAccountClient().switch('c', 9)).toBeNull();
  });

  it('remove issues a DELETE with the userId and reports ok', async () => {
    const fetch = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    expect(await createDeviceAccountClient().remove('c', 5)).toBe(true);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://auth.test/api/auth/accounts?userId=5');
    expect(init.method).toBe('DELETE');
  });

  it('degrades to empty when AUTH_JWT_ISSUER is unset (no fetch)', async () => {
    h.loadAuthEnv.mockReturnValue({});
    const fetch = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    expect(await createDeviceAccountClient().list('c')).toEqual([]);
    expect(await createDeviceAccountClient().switch('c', 1)).toBeNull();
    expect(await createDeviceAccountClient().remove('c', 1)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
