import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ loadAuthEnv: vi.fn() }));
vi.mock('../env', () => ({ loadAuthEnv: h.loadAuthEnv }));

import { createImpersonationClient } from '../impersonation-client';

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

describe('createImpersonationClient', () => {
  it('impersonate posts the target userId + forwards the cookie, returns the minted token', async () => {
    const fetch = stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ token: 'imp.jwt' }),
    }));
    expect(await createImpersonationClient().impersonate('civ-token=mod', 42)).toEqual({
      ok: true,
      token: 'imp.jwt',
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://auth.test/api/auth/impersonate');
    expect(init.method).toBe('POST');
    expect(init.headers.cookie).toBe('civ-token=mod');
    expect(JSON.parse(init.body ?? '{}')).toEqual({ userId: 42 });
  });

  it('impersonate surfaces the hub status + reason when it declines (not a moderator)', async () => {
    stubFetch(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ message: 'not permitted to impersonate' }),
    }));
    expect(await createImpersonationClient().impersonate('c', 42)).toEqual({
      ok: false,
      status: 403,
      error: 'not permitted to impersonate',
    });
  });

  it('exit posts to the exit route with no body and returns the moderator token', async () => {
    const fetch = stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ token: 'mod.jwt' }),
    }));
    expect(await createImpersonationClient().exit('civ-token=imp')).toEqual({
      ok: true,
      token: 'mod.jwt',
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://auth.test/api/auth/impersonate/exit');
    expect(init.body).toBeUndefined();
  });

  it('exit surfaces the hub status + reason for a non-impersonation session', async () => {
    stubFetch(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ message: 'not an impersonation session' }),
    }));
    expect(await createImpersonationClient().exit('civ-token=plain')).toEqual({
      ok: false,
      status: 400,
      error: 'not an impersonation session',
    });
  });

  it('no-ops (no fetch) when AUTH_JWT_ISSUER is unset — returns unreachable', async () => {
    h.loadAuthEnv.mockReturnValue({});
    const fetch = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    expect(await createImpersonationClient().impersonate('c', 1)).toEqual({
      ok: false,
      status: 0,
      error: 'hub unreachable',
    });
    expect(await createImpersonationClient().exit('c')).toEqual({
      ok: false,
      status: 0,
      error: 'hub unreachable',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
