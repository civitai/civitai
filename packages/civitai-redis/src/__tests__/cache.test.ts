import { describe, it, expect, vi } from 'vitest';
import { createRedisCacheBuilder, type RedisCacheClient } from '../index';

// A fake cache client backed by an in-memory map. Records the last-used TTL so we can assert jitter bounds.
function fakeClient() {
  const store = new Map<string, unknown>();
  let lastSetTtl: number | undefined;
  const client = {
    packed: {
      get: vi.fn(async (key: string) => (store.has(key) ? store.get(key) : null)),
      set: vi.fn(async (key: string, value: unknown, opts?: { EX?: number }) => {
        store.set(key, value);
        lastSetTtl = opts?.EX;
      }),
    },
    del: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
  return {
    builder: createRedisCacheBuilder({
      getClient: () => client as unknown as RedisCacheClient,
      prefix: 'cs',
    }),
    client,
    store,
    ttl: () => lastSetTtl,
  };
}

describe('createRedisCacheBuilder', () => {
  it('misses then hits — fetches once, serves the cached value thereafter', async () => {
    const { builder, client } = fakeClient();
    const fetch = vi.fn(async ({ id }: { id: number }) => ({ id, at: 'fresh' }));
    const cache = builder({ name: 'thing', fetch, ttlSeconds: 100 });

    expect(await cache.get({ id: 1 })).toEqual({ id: 1, at: 'fresh' });
    expect(await cache.get({ id: 1 })).toEqual({ id: 1, at: 'fresh' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(client.packed.set).toHaveBeenCalledTimes(1);
  });

  it('keys are sorted, prefixed, and independent per-args', async () => {
    const { builder, store } = fakeClient();
    const cache = builder({
      name: 'thing',
      fetch: async ({ a, b }: { a: number; b: string }) => `${a}-${b}`,
      ttlSeconds: 10,
    });

    await cache.get({ a: 1, b: 'x' });
    await cache.get({ b: 'x', a: 1 }); // same args, different order → same key
    await cache.get({ a: 2, b: 'x' }); // different args → new key

    expect([...store.keys()]).toEqual(['cs:thing:a:1:b:x', 'cs:thing:a:2:b:x']);
  });

  it('single-flights concurrent misses for the same key into one fetch', async () => {
    const { builder } = fakeClient();
    let resolve!: (v: number) => void;
    const deferred = new Promise<number>((r) => (resolve = r));
    const fetch = vi.fn(() => deferred);
    const cache = builder({ name: 'slow', fetch, ttlSeconds: 10 });

    const a = cache.get({ id: 1 });
    const b = cache.get({ id: 1 });
    await Promise.resolve(); // let both calls reach the fetcher
    resolve(42);

    expect(await a).toBe(42);
    expect(await b).toBe(42);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('derives TTL from the args and applies +0–10% jitter', async () => {
    const { builder, ttl } = fakeClient();
    const cache = builder({
      name: 'ranged',
      fetch: async ({ days }: { days: number }) => days,
      ttlSeconds: ({ days }) => (days >= 90 ? 3600 : 300),
    });

    await cache.get({ days: 90 });
    expect(ttl()).toBeGreaterThanOrEqual(3600);
    expect(ttl()).toBeLessThan(3600 * 1.1 + 1);

    await cache.get({ days: 7 });
    expect(ttl()).toBeGreaterThanOrEqual(300);
    expect(ttl()).toBeLessThan(300 * 1.1 + 1);
  });

  it('bust deletes the entry, forcing a re-fetch', async () => {
    const { builder } = fakeClient();
    const fetch = vi.fn(async ({ id }: { id: number }) => id);
    const cache = builder({ name: 'thing', fetch, ttlSeconds: 10 });

    await cache.get({ id: 1 });
    await cache.bust({ id: 1 });
    await cache.get({ id: 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('fails open — a redis read error still returns a freshly fetched value', async () => {
    const { builder, client } = fakeClient();
    client.packed.get.mockRejectedValueOnce(new Error('redis down'));
    const cache = builder({
      name: 'thing',
      fetch: async ({ id }: { id: number }) => ({ id }),
      ttlSeconds: 10,
    });

    expect(await cache.get({ id: 7 })).toEqual({ id: 7 });
  });
});
