import { describe, expect, it, vi } from 'vitest';
import { createCacheBuilders, type CacheBuilderDeps } from '../cached-array';
import type { RedisKeyTemplateCache } from '../client';

/**
 * `fetch(ids, { writeBack: false })` serves what the cache already holds but never writes: a miss
 * goes to lookupFn and is returned without a Redis SET or an L1 entry, and a stale entry is served
 * without taking the revalidate lock. The default fetch keeps writing.
 *
 * The redis stub is a Map, so a value one fetch writes is what the next fetch reads.
 */

type Row = { id: number; v: string };
const KEY = 'packed:caches:test-write-back' as RedisKeyTemplateCache;
const keyFor = (id: number) => `${KEY}:${id}`;

function build({ localTtl }: { localTtl?: number } = {}) {
  const store = new Map<string, unknown>();
  const redis = {
    packed: {
      mGet: vi.fn(async (keys: RedisKeyTemplateCache[]) => keys.map((k) => store.get(k) ?? null)),
      set: vi.fn(async (key: RedisKeyTemplateCache, value: unknown) => {
        store.set(key, value);
        return 'OK';
      }),
    },
    del: vi.fn(async () => 1),
    setNxKeepTtlWithEx: vi.fn(async () => true),
  };
  const noop = () => undefined;
  const { createCachedObject } = createCacheBuilders({
    redis: redis as unknown as CacheBuilderDeps['redis'],
    defaultTtl: 300,
    metrics: {
      hit: noop,
      miss: noop,
      revalidate: noop,
      failOpenDegraded: noop,
      failOpenOriginFetch: noop,
      missWouldJoin: noop,
    },
    logFailOpen: noop,
    logRefreshError: noop,
    log: noop,
    clearByPattern: async () => undefined,
  });
  // Ids >= 100 have no row, so they exercise the not-found marker.
  const lookupFn = vi.fn(async (ids: number[]) =>
    Object.fromEntries(ids.filter((id) => id < 100).map((id) => [id, { id, v: `db-${id}` }]))
  );
  const cache = createCachedObject<Row>({ key: KEY, idKey: 'id', lookupFn, ttl: 60, localTtl });
  return { cache, store, redis, lookupFn };
}

describe('createCachedObject fetch — writeBack option', () => {
  it('on a miss with writeBack:false, returns the origin rows but sets nothing in Redis', async () => {
    const t = build();
    const result = await t.cache.fetch([1, 2, 100], { writeBack: false });

    expect(result).toEqual({ 1: { id: 1, v: 'db-1' }, 2: { id: 2, v: 'db-2' } });
    expect(t.lookupFn).toHaveBeenCalledTimes(1);
    expect(t.redis.packed.set).not.toHaveBeenCalled();
    expect(t.store.size).toBe(0);
  });

  it('on a miss with writeBack:false, does not pin the rows in L1 either', async () => {
    const t = build({ localTtl: 30 });
    await t.cache.fetch([1], { writeBack: false });
    await t.cache.fetch([1], { writeBack: false });

    // An L1 entry from the first call would have answered the second without a lookup.
    expect(t.lookupFn).toHaveBeenCalledTimes(2);
    expect(t.redis.packed.set).not.toHaveBeenCalled();
  });

  it('[invariant on the pre-change code] serves a Redis hit with writeBack:false, without a lookup', async () => {
    const t = build();
    t.store.set(keyFor(7), { id: 7, v: 'cached-7', cachedAt: new Date() });

    const result = await t.cache.fetch([7], { writeBack: false });

    expect(result).toEqual({ 7: { id: 7, v: 'cached-7' } });
    expect(t.lookupFn).not.toHaveBeenCalled();
    expect(t.redis.packed.set).not.toHaveBeenCalled();
  });

  it('serves a stale entry with writeBack:false without taking the revalidate lock', async () => {
    const t = build();
    const stale = new Date(Date.now() - 120_000);
    t.store.set(keyFor(7), { id: 7, v: 'stale-7', cachedAt: stale });

    const result = await t.cache.fetch([7], { writeBack: false });

    expect(result).toEqual({ 7: { id: 7, v: 'stale-7' } });
    expect(t.redis.setNxKeepTtlWithEx).not.toHaveBeenCalled();
    expect(t.lookupFn).not.toHaveBeenCalled();
    expect(t.redis.packed.set).not.toHaveBeenCalled();
  });

  it('[invariant on the pre-change code] the default fetch writes misses and not-found markers back', async () => {
    const t = build({ localTtl: 30 });
    const result = await t.cache.fetch([1, 100]);

    expect(result).toEqual({ 1: { id: 1, v: 'db-1' } });
    expect(t.redis.packed.set).toHaveBeenCalledTimes(2);
    expect(t.store.get(keyFor(1))).toMatchObject({ id: 1, v: 'db-1' });
    expect(t.store.get(keyFor(100))).toMatchObject({ id: 100, notFound: true });

    // The L1 now answers id 1 without a lookup.
    await t.cache.fetch([1]);
    expect(t.lookupFn).toHaveBeenCalledTimes(1);
  });

  it('when the Redis read fails, writeBack:false skips the L1 backfill the default path makes', async () => {
    const readOnly = build({ localTtl: 30 });
    readOnly.redis.packed.mGet.mockRejectedValue(new Error('cluster down'));
    await readOnly.cache.fetch([1], { writeBack: false });
    await readOnly.cache.fetch([1], { writeBack: false });
    expect(readOnly.lookupFn).toHaveBeenCalledTimes(2);

    const writing = build({ localTtl: 30 });
    writing.redis.packed.mGet.mockRejectedValue(new Error('cluster down'));
    await writing.cache.fetch([1]);
    await writing.cache.fetch([1]);
    expect(writing.lookupFn).toHaveBeenCalledTimes(1);
  });

  it('a writeBack:false miss does not stop a later default fetch from writing', async () => {
    const t = build();
    await t.cache.fetch([1], { writeBack: false });
    await t.cache.fetch([1]);

    expect(t.lookupFn).toHaveBeenCalledTimes(2);
    expect(t.redis.packed.set).toHaveBeenCalledTimes(1);
    expect(t.store.get(keyFor(1))).toMatchObject({ id: 1, v: 'db-1' });
  });
});
