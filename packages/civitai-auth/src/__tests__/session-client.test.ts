import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SessionClaims, SessionUser } from '../types';

// Zero-config: verifier + cache + env all come from module boundaries. Mock them (no injectable config).
const h = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  return {
    store,
    verifyToken: vi.fn<(t: string) => Promise<SessionClaims | null>>(),
    cacheGet: vi.fn(async (key: string) => store.get(key) ?? null),
    loadAuthEnv: vi.fn(),
  };
});

vi.mock('../verify', () => ({ createAuthVerifier: () => ({ verifyToken: h.verifyToken }) }));
vi.mock('../redis', () => ({
  getCacheRedis: () => ({ packed: { get: h.cacheGet, set: async () => {} } }),
  sessionCacheKey: (id: number) => `session:data2:${id}`,
}));
vi.mock('../env', () => ({ loadAuthEnv: h.loadAuthEnv }));

import { createSessionClient } from '../session-client';

const key = (id: number) => `session:data2:${id}`;
const richUser = (id: number, username = 'fresh'): SessionUser =>
  ({
    id,
    username,
    showNsfw: false,
    blurNsfw: true,
    browsingLevel: 1,
    onboarding: 0,
  } as SessionUser);

type Res = { ok: boolean; status: number; json: () => Promise<unknown> };
function stubFetch(impl: (url: string, init: unknown) => Promise<Res>) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  h.store.clear();
  h.cacheGet.mockClear();
  h.cacheGet.mockImplementation(async (key: string) => h.store.get(key) ?? null);
  h.verifyToken.mockReset();
  h.verifyToken.mockImplementation(async (t: string) =>
    t === 'bad' ? null : { sub: t, iss: 'https://auth.test' }
  );
  h.loadAuthEnv.mockReturnValue({
    AUTH_JWT_ISSUER: 'https://auth.test',
    AUTH_INTERNAL_TOKEN: 'secret-123',
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('createSessionClient — getSessionUser (read)', () => {
  it('returns the cached user without fetching', async () => {
    h.store.set(key(7), richUser(7, 'bob'));
    const fetch = stubFetch(async () => ({ ok: true, status: 200, json: async () => null }));
    expect(await createSessionClient().getSessionUser('7')).toMatchObject({
      id: 7,
      username: 'bob',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('on a miss fetches the hub identity and returns it (no write-through)', async () => {
    const fetch = stubFetch(async () => ({ ok: true, status: 200, json: async () => richUser(7) }));
    expect(await createSessionClient().getSessionUser('7')).toMatchObject({
      id: 7,
      username: 'fresh',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(h.store.has(key(7))).toBe(false); // consumer does NOT write — the producer does
  });

  it('fetches the verified token iss + /api/auth/identity with a Bearer', async () => {
    const fetch = stubFetch(async () => ({ ok: true, status: 200, json: async () => richUser(7) }));
    await createSessionClient().getSessionUser('7');
    expect(fetch).toHaveBeenCalledWith('https://auth.test/api/auth/identity', {
      headers: { authorization: 'Bearer 7' },
    });
  });

  it('treats a clearedAt tombstone as a miss', async () => {
    h.store.set(key(7), { id: 7, clearedAt: 1 });
    const fetch = stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => richUser(7, 'new'),
    }));
    expect(await createSessionClient().getSessionUser('7')).toMatchObject({ username: 'new' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns null when the hub reports no session (401)', async () => {
    const fetch = stubFetch(async () => ({ ok: false, status: 401, json: async () => null }));
    expect(await createSessionClient().getSessionUser('7')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns null for an invalid token without reading cache or fetching', async () => {
    const fetch = stubFetch(async () => ({ ok: true, status: 200, json: async () => null }));
    expect(await createSessionClient().getSessionUser('bad')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(h.cacheGet).not.toHaveBeenCalled();
  });

  it('single-flights concurrent misses for the same user (one fetch)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetch = stubFetch(async () => {
      await gate;
      return { ok: true, status: 200, json: async () => richUser(7, 'one') };
    });
    const client = createSessionClient();
    const a = client.getSessionUser('7');
    const b = client.getSessionUser('7');
    await new Promise((r) => setTimeout(r, 0));
    release();
    expect(await a).toMatchObject({ username: 'one' });
    expect(await b).toMatchObject({ username: 'one' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fails open to a fetch when the cache read throws', async () => {
    h.cacheGet.mockImplementationOnce(async () => {
      throw new Error('redis down');
    });
    const fetch = stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => richUser(7, 'db'),
    }));
    expect(await createSessionClient().getSessionUser('7')).toMatchObject({ username: 'db' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns null when the hub fetch throws (no warm cache to fall back to)', async () => {
    const fetch = stubFetch(async () => {
      throw new Error('hub unreachable');
    });
    expect(await createSessionClient().getSessionUser('7')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns null when the token has no issuer to resolve against', async () => {
    h.verifyToken.mockImplementation(async (t: string) => ({ sub: t })); // no iss
    const fetch = stubFetch(async () => ({ ok: true, status: 200, json: async () => null }));
    expect(await createSessionClient().getSessionUser('7')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('createSessionClient — getSessionUserById (read by userId)', () => {
  it('returns the cached user without fetching', async () => {
    h.store.set(key(7), richUser(7, 'bob'));
    const fetch = stubFetch(async () => ({ ok: true, status: 200, json: async () => null }));
    expect(await createSessionClient().getSessionUserById(7)).toMatchObject({
      id: 7,
      username: 'bob',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('on a miss fetches the INTERNAL-authed read-through endpoint by userId (no write-through)', async () => {
    const fetch = stubFetch(async () => ({ ok: true, status: 200, json: async () => richUser(7) }));
    expect(await createSessionClient().getSessionUserById(7)).toMatchObject({
      id: 7,
      username: 'fresh',
    });
    expect(fetch).toHaveBeenCalledWith('https://auth.test/api/auth/identity?userId=7', {
      headers: { authorization: 'Bearer secret-123' },
    });
    expect(h.store.has(key(7))).toBe(false); // consumer does NOT write — the hub producer does
  });

  it('treats a clearedAt tombstone as a miss', async () => {
    h.store.set(key(7), { id: 7, clearedAt: 1 });
    const fetch = stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => richUser(7, 'new'),
    }));
    expect(await createSessionClient().getSessionUserById(7)).toMatchObject({ username: 'new' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns null (without fetching) when AUTH_INTERNAL_TOKEN is unset', async () => {
    h.loadAuthEnv.mockReturnValue({ AUTH_JWT_ISSUER: 'https://auth.test' });
    const fetch = stubFetch(async () => ({ ok: true, status: 200, json: async () => richUser(7) }));
    expect(await createSessionClient().getSessionUserById(7)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns null for a non-finite userId without reading cache or fetching', async () => {
    const fetch = stubFetch(async () => ({ ok: true, status: 200, json: async () => richUser(7) }));
    expect(await createSessionClient().getSessionUserById(Number.NaN)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(h.cacheGet).not.toHaveBeenCalled();
  });

  it('returns null when the hub reports no such user (404)', async () => {
    const fetch = stubFetch(async () => ({ ok: false, status: 404, json: async () => null }));
    expect(await createSessionClient().getSessionUserById(7)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns null when the hub fetch throws (unreachable / not configured)', async () => {
    const fetch = stubFetch(async () => {
      throw new Error('hub unreachable');
    });
    expect(await createSessionClient().getSessionUserById(7)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('single-flights concurrent misses for the same user (one fetch)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetch = stubFetch(async () => {
      await gate;
      return { ok: true, status: 200, json: async () => richUser(7, 'one') };
    });
    const client = createSessionClient();
    const a = client.getSessionUserById(7);
    const b = client.getSessionUserById(7);
    await new Promise((r) => setTimeout(r, 0));
    release();
    expect(await a).toMatchObject({ username: 'one' });
    expect(await b).toMatchObject({ username: 'one' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fails open to a fetch when the cache read throws', async () => {
    h.cacheGet.mockImplementationOnce(async () => {
      throw new Error('redis down');
    });
    const fetch = stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => richUser(7, 'db'),
    }));
    expect(await createSessionClient().getSessionUserById(7)).toMatchObject({ username: 'db' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('createSessionClient — invalidate / refresh (write)', () => {
  it('invalidate POSTs a bust (refresh:false) with the env service token and returns void', async () => {
    const fetch = stubFetch(async () => ({ ok: true, status: 204, json: async () => null }));
    await expect(createSessionClient().invalidate(7)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith('https://auth.test/api/auth/identity', {
      method: 'POST',
      headers: { authorization: 'Bearer secret-123', 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 7, refresh: false }),
    });
  });

  it('refresh POSTs refresh:true and returns the fresh user', async () => {
    const fetch = stubFetch(async () => ({ ok: true, status: 200, json: async () => richUser(7) }));
    expect(await createSessionClient().refresh(7)).toMatchObject({ id: 7, username: 'fresh' });
    expect(fetch).toHaveBeenCalledWith(
      'https://auth.test/api/auth/identity',
      expect.objectContaining({ body: JSON.stringify({ userId: 7, refresh: true }) })
    );
  });

  it('refresh returns null when the hub reports no such user', async () => {
    stubFetch(async () => ({ ok: true, status: 200, json: async () => null }));
    expect(await createSessionClient().refresh(7)).toBeNull();
  });

  it('throws on a non-ok response', async () => {
    stubFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    await expect(createSessionClient().invalidate(7)).rejects.toThrow(/invalidate failed: 500/);
  });

  it('throws (without fetching) when AUTH_INTERNAL_TOKEN is unset', async () => {
    h.loadAuthEnv.mockReturnValue({ AUTH_JWT_ISSUER: 'https://auth.test' });
    const fetch = stubFetch(async () => ({ ok: true, status: 204, json: async () => null }));
    await expect(createSessionClient().invalidate(7)).rejects.toThrow(/AUTH_INTERNAL_TOKEN/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('throws (without fetching) when AUTH_JWT_ISSUER is unset', async () => {
    h.loadAuthEnv.mockReturnValue({ AUTH_INTERNAL_TOKEN: 'secret-123' });
    const fetch = stubFetch(async () => ({ ok: true, status: 204, json: async () => null }));
    await expect(createSessionClient().invalidate(7)).rejects.toThrow(/AUTH_JWT_ISSUER/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('createSessionClient — invalidateAll (mass cutoff)', () => {
  it('POSTs scope:"all" with the service token, and resolves on 204', async () => {
    const fetch = stubFetch(async () => ({ ok: true, status: 204, json: async () => null }));
    await expect(createSessionClient().invalidateAll()).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith('https://auth.test/api/auth/identity', {
      method: 'POST',
      headers: { authorization: 'Bearer secret-123', 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'all' }),
    });
  });

  it('throws on a non-ok response', async () => {
    stubFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    await expect(createSessionClient().invalidateAll()).rejects.toThrow(
      /invalidateAll failed: 500/
    );
  });

  it('throws (without fetching) when AUTH_INTERNAL_TOKEN is unset', async () => {
    h.loadAuthEnv.mockReturnValue({ AUTH_JWT_ISSUER: 'https://auth.test' });
    const fetch = stubFetch(async () => ({ ok: true, status: 204, json: async () => null }));
    await expect(createSessionClient().invalidateAll()).rejects.toThrow(/AUTH_INTERNAL_TOKEN/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
