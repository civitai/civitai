import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RedisClientModule from '@civitai/redis/client';
import type * as StringHelpers from '~/utils/string-helpers';

/**
 * NAMESPACED half of the environment-scoped cache-key prefixing coverage (production half is
 * cache-helpers-key-prefix-prod.test.ts — the two cannot share a file because a `vi.mock`
 * factory is evaluated once per file, so `CACHE_KEY_NAMESPACE` cannot be flipped between cases).
 *
 * Pins that on a namespaced deployment every cache key and every `tag:<name>` set moves into that
 * namespace, that a tag bust still finds its members there, and that a production entry sitting
 * under the unprefixed key is neither read nor overwritten. Expected keys are hand-written
 * literals; `hashifyObject` is stubbed to a constant.
 */

// Must run before the `vi.mock` factory below imports the key table — the prefix is resolved at
// module-eval time. Note IS_PREVIEW is NOT set: the namespace is the only input that matters.
vi.hoisted(() => {
  process.env.CACHE_KEY_NAMESPACE = 'preview';
  delete process.env.IS_PREVIEW;
});

const { store, sets, fakeRedis } = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  const sets = new Map<string, Set<string>>();
  return {
    store,
    sets,
    fakeRedis: {
      packed: {
        get: async (key: string) => (store.has(key) ? store.get(key) : null),
        set: async (key: string, value: unknown) => void store.set(key, value),
      },
      sAdd: async (key: string, member: string) => {
        const set = sets.get(key) ?? new Set<string>();
        set.add(member);
        sets.set(key, set);
        return 1;
      },
      sMembers: async (key: string) => [...(sets.get(key) ?? [])],
      del: async (key: string) => {
        const hit = store.delete(key);
        const setHit = sets.delete(key);
        return hit || setHit ? 1 : 0;
      },
      setNxKeepTtlWithEx: async () => true,
    },
  };
});

vi.mock('~/server/redis/client', async () => {
  const pkg = await vi.importActual<typeof RedisClientModule>('@civitai/redis/client');
  return { ...pkg, redis: fakeRedis, sysRedis: fakeRedis };
});

vi.mock('~/utils/string-helpers', async () => {
  const actual = await vi.importActual<typeof StringHelpers>('~/utils/string-helpers');
  return { ...actual, hashifyObject: () => 'HASH' };
});

vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/prom/client', () => ({
  cacheHitCounter: { inc: vi.fn() },
  cacheMissCounter: { inc: vi.fn() },
  cacheRevalidateCounter: { inc: vi.fn() },
  cacheFailOpenDegradedCounter: { inc: vi.fn() },
  cacheFailOpenOriginFetchCounter: { inc: vi.fn() },
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn().mockResolvedValue(undefined) }));

describe('cache-helpers key prefixing — namespaced', () => {
  const rows = [{ id: 1, name: 'anime' }];
  const sql = {} as never;
  let queryRaw: ReturnType<typeof vi.fn>;
  let db: never;
  let executor: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store.clear();
    sets.clear();
    queryRaw = vi.fn().mockResolvedValue(rows);
    db = { $queryRaw: queryRaw } as never;
    executor = vi.fn().mockResolvedValue(rows);
  });

  it('exposes the configured prefix', async () => {
    const { CACHE_KEY_PREFIX } = await import('~/server/redis/client');
    expect(CACHE_KEY_PREFIX).toBe('preview:');
  });

  it('prefixes the derived key table', async () => {
    const { REDIS_KEYS } = await import('~/server/redis/client');
    expect(REDIS_KEYS.CACHES.USER_COSMETICS).toBe('preview:packed:caches:user-cosmetics');
    expect(`${REDIS_KEYS.CACHES.USER_COSMETICS}:123`).toBe(
      'preview:packed:caches:user-cosmetics:123'
    );
    expect(REDIS_KEYS.TAG).toBe('preview:tag');
  });

  it('leaves the system keyspace unprefixed', async () => {
    const { REDIS_SYS_KEYS } = await import('~/server/redis/client');
    expect(REDIS_SYS_KEYS.DEVICE.ACCOUNTS).toBe('device:accounts');
  });

  it('writes queryCache entries and tag sets under prefixed keys', async () => {
    const { queryCache } = await import('~/server/utils/cache-helpers');

    await queryCache(db, 'getTags', 'v1')(sql, { ttl: 60, tag: 'tags' });

    expect(store.get('preview:getTags:v1:HASH')).toEqual(rows);
    expect([...(sets.get('preview:tag:tags') ?? [])]).toEqual(['preview:getTags:v1:HASH']);

    // The production keys must be untouched by a namespaced write.
    expect(store.has('getTags:v1:HASH')).toBe(false);
    expect(sets.has('tag:tags')).toBe(false);
  });

  // 🔴 queryCacheRaw is a SEPARATE key minter from queryCache — it has its own `prefixCacheKey`
  // call, and without these two cases deleting that call leaves every other test in this suite
  // green (a surviving mutant). It is the path getAllImages runs on, so it is also the highest
  // traffic of the two.
  it('writes queryCacheRaw entries and tag sets under prefixed keys', async () => {
    const { queryCacheRaw } = await import('~/server/utils/cache-helpers');

    await queryCacheRaw(executor as never, 'getImagesRaw', 'v3')(sql, { ttl: 60, tag: 'images' });

    expect(store.get('preview:getImagesRaw:v3:HASH')).toEqual(rows);
    expect([...(sets.get('preview:tag:images') ?? [])]).toEqual(['preview:getImagesRaw:v3:HASH']);

    expect(store.has('getImagesRaw:v3:HASH')).toBe(false);
    expect(sets.has('tag:images')).toBe(false);
  });

  it('does not let queryCacheRaw read a production entry under the unprefixed key', async () => {
    const { queryCacheRaw } = await import('~/server/utils/cache-helpers');

    store.set('getImagesRaw:v3:HASH', [{ id: 99, name: 'production-only' }]);

    const result = await queryCacheRaw(executor as never, 'getImagesRaw', 'v3')(sql, { ttl: 60 });

    expect(executor).toHaveBeenCalledTimes(1);
    expect(result).toEqual(rows);
    expect(store.get('getImagesRaw:v3:HASH')).toEqual([{ id: 99, name: 'production-only' }]);
  });

  it('busts a tagged entry by tag', async () => {
    const { queryCache, bustCacheTag } = await import('~/server/utils/cache-helpers');
    const cacheable = queryCache(db, 'getTags', 'v1');

    await cacheable(sql, { ttl: 60, tag: 'tags' });
    expect(queryRaw).toHaveBeenCalledTimes(1);

    // Positive control: the entry and its tag set must actually EXIST under the prefixed keys
    // before the bust. Without this the "gone after bust" assertions below pass vacuously on
    // code that never prefixed anything.
    expect(store.has('preview:getTags:v1:HASH')).toBe(true);
    expect(sets.has('preview:tag:tags')).toBe(true);

    await cacheable(sql, { ttl: 60, tag: 'tags' });
    expect(queryRaw).toHaveBeenCalledTimes(1);

    await bustCacheTag('tags');
    expect(store.has('preview:getTags:v1:HASH')).toBe(false);
    expect(sets.has('preview:tag:tags')).toBe(false);

    await cacheable(sql, { ttl: 60, tag: 'tags' });
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it('does not read a production entry written under the unprefixed key', async () => {
    const { queryCache } = await import('~/server/utils/cache-helpers');

    // Pre-seed the production key, as production would have.
    store.set('getTags:v1:HASH', [{ id: 99, name: 'production-only' }]);

    const result = await queryCache(db, 'getTags', 'v1')(sql, { ttl: 60 });

    // The preview misses and fetches from its own database instead of serving production's value.
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(result).toEqual(rows);
    expect(store.get('getTags:v1:HASH')).toEqual([{ id: 99, name: 'production-only' }]);
  });
});
