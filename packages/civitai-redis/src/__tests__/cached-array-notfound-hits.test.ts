import { describe, expect, it, vi } from 'vitest';
import { createCacheBuilders, type CacheBuilderDeps } from '../cached-array';
import type { RedisKeyTemplateCache } from '../client';

/**
 * A notFound marker served from Redis skips the lookup exactly as a cached row does, so it is a
 * hit. It used to be counted as nothing at all while its refill counted as a miss, so a cache
 * whose ids mostly have no row reported a hit ratio near zero however well it worked.
 *
 * Negative hits go under their own cache_type, so `cachedArray` keeps meaning "a row was served".
 */

type Row = { id: number; v: string };
const KEY = 'packed:caches:test-notfound-hits' as RedisKeyTemplateCache;

function build() {
  const store = new Map<string, unknown>();
  const redis = {
    packed: {
      mGet: vi.fn(async (keys: RedisKeyTemplateCache[]) =>
        keys.map((k) => (store.has(k) ? structuredClone(store.get(k)) : null))
      ),
      set: vi.fn(async (key: RedisKeyTemplateCache, value: unknown, opts?: { NX?: boolean }) => {
        if (opts?.NX && store.has(key)) return null;
        store.set(key, structuredClone(value));
        return 'OK';
      }),
    },
    del: vi.fn(async () => 1),
    setNxKeepTtlWithEx: vi.fn(async () => true),
  };
  // Every metric call, as [kind, cacheType, count].
  const calls: [string, string, number][] = [];
  const record =
    (kind: string) =>
    (_name: string, type: string, count: number): void => {
      calls.push([kind, type, count]);
    };
  const noop = () => undefined;
  const { createCachedObject } = createCacheBuilders({
    redis: redis as unknown as CacheBuilderDeps['redis'],
    defaultTtl: 300,
    metrics: {
      hit: record('hit'),
      miss: record('miss'),
      revalidate: record('revalidate'),
      failOpenDegraded: noop,
      failOpenOriginFetch: noop,
      missWouldJoin: noop,
    },
    logFailOpen: noop,
    logRefreshError: noop,
    log: noop,
    clearByPattern: async () => undefined,
  });
  // Only ids below 100 have a row.
  const lookupFn = vi.fn(async (ids: number[]) =>
    Object.fromEntries(ids.filter((id) => id < 100).map((id) => [id, { id, v: `db-${id}` }]))
  );
  const cache = createCachedObject<Row>({
    key: KEY,
    idKey: 'id',
    lookupFn,
    ttl: 3600,
    staleWhileRevalidate: false,
  });
  return { cache, lookupFn, calls };
}

describe('createCachedObject counts notFound-marker hits', () => {
  it('a negative result is cached: the second fetch skips the lookup and counts a hit', async () => {
    const t = build();

    // Three ids with no row and one with a row: the first read misses all four.
    const first = await t.cache.fetch([101, 102, 103, 1]);
    expect(first).toEqual({ 1: { id: 1, v: 'db-1' } });
    expect(t.lookupFn).toHaveBeenCalledTimes(1);
    expect(t.calls).toEqual([['miss', 'cachedArray', 4]]);

    t.calls.length = 0;
    const second = await t.cache.fetch([101, 102, 103, 1]);

    // Same output, no origin read.
    expect(second).toEqual({ 1: { id: 1, v: 'db-1' } });
    expect(t.lookupFn).toHaveBeenCalledTimes(1);
    // Three negative hits and one row hit, each under its own type; nothing counted as a miss.
    expect(t.calls).toEqual(
      expect.arrayContaining([
        ['hit', 'cachedArray', 1],
        ['hit', 'cachedArrayNotFound', 3],
      ])
    );
    expect(t.calls).toHaveLength(2);
  });

  it('an all-negative read reports every id as a hit', async () => {
    const t = build();
    await t.cache.fetch([201, 202]);
    t.calls.length = 0;

    await t.cache.fetch([201, 202]);

    expect(t.calls).toEqual([['hit', 'cachedArrayNotFound', 2]]);
    expect(t.lookupFn).toHaveBeenCalledTimes(1);
  });
});
