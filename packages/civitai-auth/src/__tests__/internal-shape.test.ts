import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The hub clients send a user's session beside this app's own credential only once the hub has confirmed that
// credential through /api/auth/internal-ping; before that, or when it is refused, they keep the legacy shape.

const h = vi.hoisted(() => ({ loadAuthEnv: vi.fn() }));
vi.mock('../env', () => ({ loadAuthEnv: h.loadAuthEnv }));

type Init = { method?: string; headers: Record<string, string>; body?: string };

// The hub: internal-ping accepts only `hubSecret`; every other route answers 200 with a token.
function stubHub(hubSecret: string) {
  const fn = vi.fn(async (url: string, init: Init) => {
    if (url.endsWith('/api/auth/internal-ping')) {
      const ok = init.headers.authorization === `Bearer ${hubSecret}`;
      return { ok, status: ok ? 204 : 401, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ token: 't', accounts: [] }) };
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

// The module keeps the hub's answer, so each test starts from a fresh copy.
async function load(appSecret?: string) {
  h.loadAuthEnv.mockReturnValue({
    AUTH_JWT_ISSUER: 'https://auth.test',
    AUTH_INTERNAL_TOKEN: appSecret,
  });
  vi.resetModules();
  const hub = await import('../hub');
  const { createSessionTokenClient } = await import('../session-token-client');
  const { createDeviceAccountClient } = await import('../device-client');
  const { createImpersonationClient } = await import('../impersonation-client');
  return { hub, createSessionTokenClient, createDeviceAccountClient, createImpersonationClient };
}

const hubCalls = (fetch: ReturnType<typeof stubHub>) =>
  fetch.mock.calls.filter(([url]) => !url.endsWith('/internal-ping'));

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('probeInternalParity', () => {
  it('is 1 for the matching credential and 0 for a wrong or missing one', async () => {
    stubHub('secret');
    expect(await (await load('secret')).hub.probeInternalParity()).toBe(1);
    expect(await (await load('wrong')).hub.probeInternalParity()).toBe(0);
    expect(await (await load(undefined)).hub.probeInternalParity()).toBe(0);
  });

  it('throws when the hub has no answer about the credential', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }))
    );
    await expect((await load('secret')).hub.probeInternalParity()).rejects.toThrow();
  });
});

describe('client request shape', () => {
  it('sends the session in the body once the hub confirms the credential', async () => {
    const fetch = stubHub('secret');
    const m = await load('secret');
    await m.hub.refreshInternalParity();

    await m.createSessionTokenClient().refresh('cur.jwt', { deviceCookie: 'dev-1' });
    await m.createDeviceAccountClient().list('civ-token=cur.jwt; civ-device=dev-1');
    await m.createDeviceAccountClient().switch('civ-token=cur.jwt; civ-device=dev-1', 9);
    await m.createImpersonationClient().impersonate('civ-token=cur.jwt', 7);
    await m.createSessionTokenClient().revoke('cur.jwt');

    const calls = hubCalls(fetch);
    expect(calls.map(([url, init]) => [new URL(url).pathname, init.method])).toEqual([
      ['/api/auth/refresh', 'POST'],
      ['/api/auth/accounts', 'POST'],
      ['/api/auth/switch', 'POST'],
      ['/api/auth/impersonate', 'POST'],
      ['/logout', 'POST'],
    ]);
    for (const [, init] of calls) {
      expect(init.headers.authorization).toBe('Bearer secret');
      expect(init.headers.cookie).toBeUndefined();
      expect(JSON.parse(init.body ?? '{}').token).toBe('cur.jwt');
    }
    expect(JSON.parse(calls[0][1].body ?? '{}').deviceId).toBe('dev-1');
    expect(JSON.parse(calls[2][1].body ?? '{}')).toMatchObject({ deviceId: 'dev-1', userId: 9 });
  });

  it('keeps the legacy shape when the hub refuses the credential', async () => {
    const fetch = stubHub('secret');
    const m = await load('wrong');
    await m.hub.refreshInternalParity();

    await m.createSessionTokenClient().refresh('cur.jwt');
    await m.createDeviceAccountClient().list('civ-token=cur.jwt');

    const [refresh, list] = hubCalls(fetch);
    expect(refresh[1].headers.authorization).toBe('Bearer cur.jwt');
    expect(refresh[1].body).toBeUndefined();
    expect(list[1].method).toBe('GET');
    expect(list[1].headers.cookie).toBe('civ-token=cur.jwt');
  });

  it('keeps the legacy shape until the first answer arrives', async () => {
    const fetch = stubHub('secret');
    const m = await load('secret');

    await m.createSessionTokenClient().refresh('cur.jwt');
    expect(hubCalls(fetch)[0][1].headers.authorization).toBe('Bearer cur.jwt');
  });
});

describe('refresh onFailure', () => {
  it('reports declined for a refusal and unreachable for no answer', async () => {
    const m = await load(undefined);
    const onFailure = vi.fn();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }))
    );
    await m.createSessionTokenClient().refresh('cur', { onFailure });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('down')))
    );
    await m.createSessionTokenClient().refresh('cur', { onFailure });

    expect(onFailure.mock.calls).toEqual([['declined'], ['unreachable']]);
  });
});
