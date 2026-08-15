import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// server-domain.ts validates the full server env at import, which the canonical env mock in
// the global setup already satisfies. getAvailableOAuthProviders reads
// process.env.AUTH_JWT_ISSUER directly rather than the validated `env`, so the defaults the
// canonical mock supplies cannot reach its logic.

describe('getAvailableOAuthProviders', () => {
  beforeEach(() => {
    vi.resetModules(); // fresh module = fresh in-memory providers cache per case
    process.env.AUTH_JWT_ISSUER = 'https://auth.test';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AUTH_JWT_ISSUER;
  });

  it('fetches the hub, intersects with the known provider set, and caches the result', async () => {
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      json: async () => ({
        providers: [
          { id: 'discord', name: 'Discord' },
          { id: 'google', name: 'Google' },
          { id: 'apple', name: 'Apple' }, // hub may enable a provider the spoke UI doesn't render
        ],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { getAvailableOAuthProviders } = await import('../server-domain');

    expect(await getAvailableOAuthProviders()).toEqual(['discord', 'google']); // 'apple' dropped
    expect(fetchMock.mock.calls[0][0]).toBe('https://auth.test/api/auth/providers');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second call is served from the in-memory cache — no extra hub hop.
    await getAvailableOAuthProviders();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails OPEN to an empty list when the hub responds non-OK', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, json: async () => ({}) }))
    );
    const { getAvailableOAuthProviders } = await import('../server-domain');
    expect(await getAvailableOAuthProviders()).toEqual([]);
  });

  it('fails OPEN when the hub fetch throws (unreachable)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      })
    );
    const { getAvailableOAuthProviders } = await import('../server-domain');
    expect(await getAvailableOAuthProviders()).toEqual([]);
  });

  it('makes no hub call when AUTH_JWT_ISSUER is unset', async () => {
    delete process.env.AUTH_JWT_ISSUER;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { getAvailableOAuthProviders } = await import('../server-domain');
    expect(await getAvailableOAuthProviders()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
