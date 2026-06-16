import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ loadAuthEnv: vi.fn() }));
vi.mock('../env', () => ({ loadAuthEnv: h.loadAuthEnv }));

import { createExchangeClient } from '../exchange-client';

type Res = { ok: boolean; status: number; json: () => Promise<unknown> };
function stubFetch(impl: (url: string, init: { method?: string; body?: string }) => Promise<Res>) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  h.loadAuthEnv.mockReturnValue({ AUTH_JWT_ISSUER: 'https://auth.test' });
});
afterEach(() => vi.unstubAllGlobals());

describe('createExchangeClient', () => {
  it('exchanges a swap token for a civ-token', async () => {
    const fetch = stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ token: 'civ.jwt', userId: 7 }),
    }));
    expect(await createExchangeClient().exchange('swap.jwt')).toEqual({ token: 'civ.jwt', userId: 7 });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://auth.test/api/auth/exchange');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body ?? '{}')).toEqual({ swapToken: 'swap.jwt' });
  });

  it('returns null when the hub rejects (invalid/used)', async () => {
    stubFetch(async () => ({ ok: false, status: 409, json: async () => ({}) }));
    expect(await createExchangeClient().exchange('swap.jwt')).toBeNull();
  });

  it('returns null on a malformed response', async () => {
    stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ token: 'x' }) }));
    expect(await createExchangeClient().exchange('swap.jwt')).toBeNull();
  });

  it('no-ops (no fetch) when unconfigured or token empty', async () => {
    h.loadAuthEnv.mockReturnValue({});
    const fetch = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    expect(await createExchangeClient().exchange('swap.jwt')).toBeNull();
    h.loadAuthEnv.mockReturnValue({ AUTH_JWT_ISSUER: 'https://auth.test' });
    expect(await createExchangeClient().exchange('')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
