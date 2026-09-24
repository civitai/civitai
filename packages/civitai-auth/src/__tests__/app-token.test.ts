import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ loadAuthEnv: vi.fn() }));
vi.mock('../env', () => ({ loadAuthEnv: h.loadAuthEnv }));

import { mintAppToken, AppTokenError } from '../app-token';

type Res = { ok: boolean; status: number; json: () => Promise<unknown> };
function stubFetch(impl: (url: string, init: RequestInit) => Promise<Res>) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  h.loadAuthEnv.mockReturnValue({
    AUTH_JWT_ISSUER: 'https://auth.test',
    AUTH_INTERNAL_TOKEN: 'svc-secret',
  });
});
afterEach(() => vi.unstubAllGlobals());

const input = { userId: 7, clientId: 'app-1', scope: 5, ttlSeconds: 600 };

describe('mintAppToken', () => {
  it('posts the mint request under the service-secret bearer and maps the hub response', async () => {
    const fetch = stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'civitai_abc',
        token_type: 'Bearer',
        expires_in: 600,
        expires_at: '2026-09-24T12:00:00.000Z',
        scope: 5,
      }),
    }));

    expect(await mintAppToken(input)).toEqual({
      accessToken: 'civitai_abc',
      expiresAt: '2026-09-24T12:00:00.000Z',
      expiresIn: 600,
      scope: 5,
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://auth.test/api/auth/oauth/app-token');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer svc-secret');
    expect(JSON.parse(init.body as string)).toEqual(input);
  });

  it('throws an AppTokenError carrying the hub error code on a non-2xx', async () => {
    stubFetch(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: 'consent_required' }),
    }));

    const err = await mintAppToken(input).catch((e) => e);
    expect(err).toBeInstanceOf(AppTokenError);
    expect(err.code).toBe('consent_required');
    expect(err.status).toBe(403);
  });

  it('throws without calling the hub when AUTH_INTERNAL_TOKEN is unset', async () => {
    h.loadAuthEnv.mockReturnValue({ AUTH_JWT_ISSUER: 'https://auth.test' });
    const fetch = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    await expect(mintAppToken(input)).rejects.toBeInstanceOf(AppTokenError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
