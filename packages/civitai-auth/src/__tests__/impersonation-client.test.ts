import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ loadAuthEnv: vi.fn() }));
vi.mock('../env', () => ({ loadAuthEnv: h.loadAuthEnv }));

import { parseCookieHeader, readSessionToken } from '../cookies';
import { refreshInternalParity } from '../hub';
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
    expect(await createImpersonationClient().impersonate('civ-token=mod', 42, null)).toEqual({
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
    expect(await createImpersonationClient().impersonate('c', 42, null)).toEqual({
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
    expect(await createImpersonationClient().exit('civ-token=imp', null)).toEqual({
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
    expect(await createImpersonationClient().exit('civ-token=plain', null)).toEqual({
      ok: false,
      status: 400,
      error: 'not an impersonation session',
    });
  });

  it('no-ops (no fetch) when AUTH_JWT_ISSUER is unset — returns unreachable', async () => {
    h.loadAuthEnv.mockReturnValue({});
    const fetch = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    expect(await createImpersonationClient().impersonate('c', 1, null)).toEqual({
      ok: false,
      status: 0,
      error: 'hub unreachable',
    });
    expect(await createImpersonationClient().exit('c', null)).toEqual({
      ok: false,
      status: 0,
      error: 'hub unreachable',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

// With the internal credential accepted, the session the client read travels in the body as `token`.
describe('createImpersonationClient — which session cookie it forwards', () => {
  const ORIGINAL_ENV = { ...process.env };
  const SHARED = '__Secure-civ-token';
  const HOST = '__Host-civ-token';
  let fetch: ReturnType<typeof stubFetch>;

  beforeEach(async () => {
    process.env.AUTH_JWT_ISSUER = 'https://auth.civitai.com';
    process.env.AUTH_SESSION_COOKIE_MODE = 'shared';
    process.env.AUTH_SESSION_COOKIE_MODE_BY_SITE = 'civitai.red:host';
    delete process.env.AUTH_LEGACY_READ;
    delete process.env.NEXT_PUBLIC_BASE_URL;
    h.loadAuthEnv.mockReturnValue({
      AUTH_JWT_ISSUER: 'https://auth.test',
      AUTH_INTERNAL_TOKEN: 'i',
    });
    fetch = stubFetch(async (url) =>
      url.endsWith('/internal-ping')
        ? { ok: true, status: 204, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ token: 't' }) }
    );
    await refreshInternalParity();
  });
  afterEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    h.loadAuthEnv.mockReturnValue({ AUTH_JWT_ISSUER: 'https://auth.test' });
    vi.unstubAllGlobals();
    stubFetch(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    await refreshInternalParity();
  });

  const forwarded = () => {
    const [, init] = fetch.mock.calls.at(-1)!;
    return JSON.parse(init.body ?? '{}').token as string | undefined;
  };

  it('a shared-mode site forwards a session held only in the host-only slot', async () => {
    await createImpersonationClient().impersonate(`${HOST}=h`, 2, 'civitai.com');
    expect(forwarded()).toBe('h');
    await createImpersonationClient().exit(`${HOST}=h`, 'civitai.com');
    expect(forwarded()).toBe('h');
  });

  it('a host-listed site forwards no session when only the shared slot is present', async () => {
    const header = `${SHARED}=s`;
    expect(readSessionToken(parseCookieHeader(header), { host: 'civitai.red' })).toBeNull();
    await createImpersonationClient().impersonate(header, 2, 'civitai.red');
    expect(forwarded()).toBeUndefined();
  });

  it("with both slots present, the site's own slot wins", async () => {
    const header = `${SHARED}=s; ${HOST}=h`;
    await createImpersonationClient().impersonate(header, 2, 'civitai.com');
    expect(forwarded()).toBe('s');
    await createImpersonationClient().impersonate(header, 2, 'civitai.red');
    expect(forwarded()).toBe('h');
  });
});
