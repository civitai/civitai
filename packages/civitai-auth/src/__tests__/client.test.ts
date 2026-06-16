import { describe, it, expect, vi, afterEach } from 'vitest';
import { createAuthBrowserClient } from '../client';

const HUB = 'https://auth.test';
const client = () => createAuthBrowserClient(HUB);

type Res = { ok: boolean; status: number; json: () => Promise<unknown> };
function stubFetch(impl: (url: string, init: { method?: string; body?: string; credentials?: string }) => Promise<Res>) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}
afterEach(() => vi.unstubAllGlobals());

describe('createAuthBrowserClient (browser → hub, credentials)', () => {
  it('listAccounts GETs the hub accounts endpoint with credentials', async () => {
    const fetch = stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ accounts: [{ userId: 1, active: true, lastSwitchedAt: 9 }] }),
    }));
    expect(await client().listAccounts()).toEqual([{ userId: 1, active: true, lastSwitchedAt: 9 }]);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://auth.test/api/auth/accounts');
    expect(init.credentials).toBe('include');
  });

  it('listAccounts returns [] on a non-ok response', async () => {
    stubFetch(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    expect(await client().listAccounts()).toEqual([]);
  });

  it('switchAccount POSTs the userId to the hub and reports ok', async () => {
    const fetch = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    expect(await client().switchAccount(5)).toBe(true);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://auth.test/api/auth/switch');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(init.body ?? '{}')).toEqual({ userId: 5 });
  });

  it('switchAccount returns false when the hub declines', async () => {
    stubFetch(async () => ({ ok: false, status: 403, json: async () => ({}) }));
    expect(await client().switchAccount(5)).toBe(false);
  });

  it('removeAccount DELETEs the hub with the userId', async () => {
    const fetch = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    expect(await client().removeAccount(7)).toBe(true);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://auth.test/api/auth/accounts?userId=7');
    expect(init.method).toBe('DELETE');
  });

  it('impersonate throws the hub error message on failure', async () => {
    stubFetch(async () => ({ ok: false, status: 403, json: async () => ({ error: 'not a moderator' }) }));
    await expect(client().impersonate(9)).rejects.toThrow('not a moderator');
  });

  it('impersonate resolves on success', async () => {
    stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    await expect(client().impersonate(9)).resolves.toBeUndefined();
  });

  it('exitImpersonation DELETEs the hub impersonate route', async () => {
    const fetch = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    await client().exitImpersonation();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://auth.test/api/auth/impersonate');
    expect(init.method).toBe('DELETE');
  });
});
