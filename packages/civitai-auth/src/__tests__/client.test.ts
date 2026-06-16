import { describe, it, expect, vi, afterEach } from 'vitest';
import { authClient } from '../client';

type Res = { ok: boolean; status: number; json: () => Promise<unknown> };
function stubFetch(impl: (url: string, init: { method?: string; body?: string }) => Promise<Res>) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}
afterEach(() => vi.unstubAllGlobals());

describe('authClient (browser → same-origin proxy)', () => {
  it('listAccounts GETs the accounts proxy and returns the rows', async () => {
    const fetch = stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ accounts: [{ userId: 1, active: true, lastSwitchedAt: 9 }] }),
    }));
    expect(await authClient.listAccounts()).toEqual([{ userId: 1, active: true, lastSwitchedAt: 9 }]);
    expect(fetch.mock.calls[0][0]).toBe('/api/auth/accounts');
  });

  it('listAccounts returns [] on a non-ok response', async () => {
    stubFetch(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    expect(await authClient.listAccounts()).toEqual([]);
  });

  it('switchAccount POSTs the userId and reports ok', async () => {
    const fetch = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    expect(await authClient.switchAccount(5)).toBe(true);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/auth/switch');
    expect(JSON.parse(init.body ?? '{}')).toEqual({ userId: 5 });
  });

  it('switchAccount returns false when the hub declines (→ caller re-logs-in)', async () => {
    stubFetch(async () => ({ ok: false, status: 403, json: async () => ({}) }));
    expect(await authClient.switchAccount(5)).toBe(false);
  });

  it('removeAccount DELETEs with the userId', async () => {
    const fetch = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    expect(await authClient.removeAccount(7)).toBe(true);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/auth/accounts?userId=7');
    expect(init.method).toBe('DELETE');
  });

  it('impersonate throws the proxy error message on failure', async () => {
    stubFetch(async () => ({ ok: false, status: 403, json: async () => ({ error: 'not a moderator' }) }));
    await expect(authClient.impersonate(9)).rejects.toThrow('not a moderator');
  });

  it('impersonate resolves on success', async () => {
    stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    await expect(authClient.impersonate(9)).resolves.toBeUndefined();
  });

  it('exitImpersonation DELETEs the impersonate route', async () => {
    const fetch = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    await authClient.exitImpersonation();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/auth/impersonate');
    expect(init.method).toBe('DELETE');
  });
});
