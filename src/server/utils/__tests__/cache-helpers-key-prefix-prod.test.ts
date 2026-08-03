import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RedisClientModule from '@civitai/redis/client';
import type * as StringHelpers from '~/utils/string-helpers';

/**
 * PRODUCTION half of the environment-scoped cache-key prefixing coverage (the preview half is
 * cache-helpers-key-prefix-preview.test.ts — the two cannot share a file because a `vi.mock`
 * factory is evaluated once per file, so `IS_PREVIEW` cannot be flipped between cases).
 *
 * 🔴 This file is the one that pins "production keys do not move". `queryCache` entries and the
 * `tag:<name>` sets that invalidate them must come out byte-identical to what they were before
 * environment prefixing existed. Expected keys are hand-written literals; `hashifyObject` is
 * stubbed to a constant so the whole key is a literal rather than a value recomputed from the
 * code under test.
 */

// Guarantee the production shape regardless of the ambient environment. Hoisted so it runs
// before the `vi.mock` factory below imports the key table (the prefix is resolved at
// module-eval time).
vi.hoisted(() => {
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

// Real REDIS_KEYS / prefixCacheKey from the package, live clients swapped for the fake above.
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

describe('cache-helpers key prefixing — production', () => {
  const rows = [{ id: 1, name: 'anime' }];
  // `sql` stands in for a Prisma.Sql — hashifyObject is stubbed, so its contents don't matter.
  const sql = {} as never;
  let queryRaw: ReturnType<typeof vi.fn>;
  let db: never;

  beforeEach(() => {
    store.clear();
    sets.clear();
    queryRaw = vi.fn().mockResolvedValue(rows);
    db = { $queryRaw: queryRaw } as never;
  });

  it('exposes an empty prefix', async () => {
    const { CACHE_KEY_PREFIX } = await import('~/server/redis/client');
    expect(CACHE_KEY_PREFIX).toBe('');
  });

  it('leaves the derived key table byte-identical', async () => {
    const { REDIS_KEYS } = await import('~/server/redis/client');
    expect(REDIS_KEYS.CACHES.USER_COSMETICS).toBe('packed:caches:user-cosmetics');
    expect(`${REDIS_KEYS.CACHES.USER_COSMETICS}:123`).toBe('packed:caches:user-cosmetics:123');
    expect(REDIS_KEYS.TAG).toBe('tag');
  });

  it('writes queryCache entries and tag sets under the unprefixed keys', async () => {
    const { queryCache } = await import('~/server/utils/cache-helpers');

    await queryCache(db, 'getTags', 'v1')(sql, { ttl: 60, tag: 'tags' });

    expect(store.get('getTags:v1:HASH')).toEqual(rows);
    expect([...(sets.get('tag:tags') ?? [])]).toEqual(['getTags:v1:HASH']);
  });

  it('busts a tagged entry by tag', async () => {
    const { queryCache, bustCacheTag } = await import('~/server/utils/cache-helpers');
    const cacheable = queryCache(db, 'getTags', 'v1');

    await cacheable(sql, { ttl: 60, tag: 'tags' });
    expect(queryRaw).toHaveBeenCalledTimes(1);

    // Positive control: the entry and its tag set exist under the unprefixed keys before the bust.
    expect(store.has('getTags:v1:HASH')).toBe(true);
    expect(sets.has('tag:tags')).toBe(true);

    // Served from cache — the origin is not hit again.
    await cacheable(sql, { ttl: 60, tag: 'tags' });
    expect(queryRaw).toHaveBeenCalledTimes(1);

    await bustCacheTag('tags');
    expect(store.has('getTags:v1:HASH')).toBe(false);
    expect(sets.has('tag:tags')).toBe(false);

    // Cold again — the bust really removed the entry.
    await cacheable(sql, { ttl: 60, tag: 'tags' });
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });
});
