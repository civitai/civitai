import type { Prisma, PrismaClient } from '@prisma/client';
import { chunk } from 'lodash-es';
import { CacheTTL } from '~/server/common/constants';
import { cacheHitCounter, cacheMissCounter, cacheRevalidateCounter } from '~/server/prom/client';
import type { RedisKeyTemplateCache } from '~/server/redis/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { sleep } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';
import { hashifyObject } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';

const log = createLogger('cache-helpers', 'cyan');

type cachedQueryOptions = {
  ttl: number;
  tag: string | string[];
};
export function queryCache(db: PrismaClient, key: string, version?: string) {
  return async function <T extends object[]>(query: Prisma.Sql, options?: cachedQueryOptions) {
    if (options?.ttl === 0) return db.$queryRaw<T>(query);

    // this typing is not quite right, as we're creating redis keys on the fly here
    const cacheKey = [key, version, hashifyObject(query).toString()]
      .filter(isDefined)
      .join(':') as RedisKeyTemplateCache;
    const cachedData = await redis.packed.get<T>(cacheKey);
    if (cachedData && options?.ttl !== 0) {
      cacheHitCounter.inc({ cache_name: key, cache_type: 'queryCache' });
      return cachedData ?? ([] as unknown as T);
    }

    cacheMissCounter.inc({ cache_name: key, cache_type: 'queryCache' });
    const result = await db.$queryRaw<T>(query);
    await redis.packed.set(cacheKey, result, { EX: options?.ttl });

    if (options?.tag) await tagCacheKey(cacheKey, options?.tag);
    return result;
  };
}

async function tagCacheKey(key: string, tag: string | string[]) {
  const tags = Array.isArray(tag) ? tag : [tag];
  for (const tag of tags) {
    await redis.sAdd(`${REDIS_KEYS.TAG}:${tag}`, key);
  }
}

export async function bustCacheTag(tag: string | string[]) {
  const tags = Array.isArray(tag) ? tag : [tag];
  for (const tag of tags) {
    const keys = await redis.packed.sMembers<RedisKeyTemplateCache>(`${REDIS_KEYS.TAG}:${tag}`);
    for (const key of keys) await redis.del(key);
    await redis.del(`${REDIS_KEYS.TAG}:${tag}`);
  }
}

type CachedLookupOptions<T extends object> = {
  key: RedisKeyTemplateCache;
  idKey: keyof T;
  lookupFn: (ids: number[], fromWrite?: boolean) => Promise<Record<string, T>>;
  appendFn?: (results: Set<T>) => Promise<void>;
  ttl?: number;
  debounceTime?: number;
  cacheNotFound?: boolean;
  dontCacheFn?: (data: T) => boolean;
  staleWhileRevalidate?: boolean;
};
export function createCachedArray<T extends object>({
  key,
  idKey,
  lookupFn,
  appendFn,
  ttl = CacheTTL.xs,
  debounceTime = 10,
  cacheNotFound = true,
  dontCacheFn,
  staleWhileRevalidate = true,
}: CachedLookupOptions<T>) {
  async function fetch(ids: number[]) {
    if (!ids.length) return [] as T[];
    const results = new Set<T>();
    const cacheResults: T[] = [];
    for (const batch of chunk(ids, 200)) {
      const batchResults = await redis.packed.mGet<T>(
        batch.map((id) => `${key}:${id}` as RedisKeyTemplateCache)
      );
      cacheResults.push(...batchResults.filter(isDefined));
    }
    const cacheArray = cacheResults.filter((x) => x !== null) as T[];
    const cache = Object.fromEntries(cacheArray.map((x) => [x[idKey], x]));

    const cacheDebounceCutoff = new Date(Date.now() - debounceTime * 1000);
    const cacheMisses = new Set<number>();
    const dontCache = new Set<number>();
    const toRevalidate: Record<number, T> = {};
    const ttlExpiry = new Date(Date.now() - ttl * 1000);
    const locks = new Set<RedisKeyTemplateCache>();
    let cacheHits = 0;
    for (const id of [...new Set(ids)]) {
      const cached = cache[id];
      if (cached) {
        if (cached.notFound) continue;
        if (cached.debounce) {
          if (cached.cachedAt > cacheDebounceCutoff) dontCache.add(id);
          cacheMisses.add(id);
          continue;
        }
        if (staleWhileRevalidate && cached.cachedAt < ttlExpiry) {
          toRevalidate[id] = cached;
          continue;
        }
        results.add(cached);
        cacheHits++;
      } else cacheMisses.add(id);
    }

    // Track cache hits
    if (cacheHits > 0) {
      cacheHitCounter.inc({ cache_name: key, cache_type: 'cachedArray' }, cacheHits);
    }

    const toRevalidateIds = Object.keys(toRevalidate).map(Number);
    if (toRevalidateIds.length > 0) {
      // Track revalidations
      cacheRevalidateCounter.inc(
        { cache_name: key, cache_type: 'cachedArray' },
        toRevalidateIds.length
      );

      const gotLocks = await Promise.all(
        toRevalidateIds.map((id) =>
          redis.setNxKeepTtlWithEx(`${REDIS_KEYS.CACHE_LOCKS}:${key}:${id}`, '1', 10)
        )
      );
      for (let i = 0; i < toRevalidateIds.length; i++) {
        const id = toRevalidateIds[i];
        if (!gotLocks[i]) {
          results.add(toRevalidate[id]);
          continue;
        }
        cacheMisses.add(id);
        locks.add(`${REDIS_KEYS.CACHE_LOCKS}:${key}:${id}`);
      }
    }

    if (dontCache.size > 0)
      log(`${key}: Cache debounce - ${dontCache.size} items: ${[...dontCache].join(', ')}`);

    // If we have cache misses, we need to fetch from the DB
    if (cacheMisses.size > 0) {
      log(`${key}: Cache miss - ${cacheMisses.size} items: ${[...cacheMisses].join(', ')}`);

      const dbResults: Record<string, T> = {};
      const lookupBatches = chunk([...cacheMisses], 10000);
      for (const batch of lookupBatches) {
        const batchResults = await lookupFn([...batch] as typeof ids);
        Object.assign(dbResults, batchResults);
      }

      const toCache: Record<string, MixedObject> = {};
      const toCacheNotFound: Record<string, MixedObject> = {};
      const cachedAt = new Date();
      let actualMisses = 0;
      for (const id of cacheMisses) {
        const result = dbResults[id];
        if (!result) {
          if (cacheNotFound) {
            toCacheNotFound[id] = { [idKey]: id, notFound: true, cachedAt };
            // Count as miss when we cache notFound markers
            actualMisses++;
          }
          // When cacheNotFound=false, don't count as miss since we don't cache it
          continue;
        }
        results.add(result as T);
        actualMisses++;
        if (!dontCache.has(id) && !dontCacheFn?.(result)) toCache[id] = { ...result, cachedAt };
      }

      // Track cache misses - only count items we actually fetched or cached as notFound
      if (actualMisses > 0) {
        cacheMissCounter.inc({ cache_name: key, cache_type: 'cachedArray' }, actualMisses);
      }

      // then cache the results
      const EX = staleWhileRevalidate ? ttl * 2 : ttl;
      if (Object.keys(toCache).length > 0)
        await Promise.all(
          Object.entries(toCache).map(([id, cache]) =>
            redis.packed.set(`${key}:${id}`, cache, { EX })
          )
        );

      // Use NX to avoid overwriting a value with a not found...
      if (Object.keys(toCacheNotFound).length > 0)
        await Promise.all(
          Object.entries(toCacheNotFound).map(([id, cache]) =>
            redis.packed.set(`${key}:${id}`, cache, { EX, NX: true })
          )
        );
    }

    // Remove locks
    if (locks.size > 0) await redis.del([...locks]);

    if (appendFn) await appendFn(results);

    return [...results].map((x) => {
      // Remove cachedAt from result since this is an internal value
      if ('cachedAt' in x) delete x.cachedAt;
      return x;
    });
  }

  async function bust(id: number | number[], options: { debounceTime?: number } = {}) {
    const ids = Array.isArray(id) ? id : [id];
    if (ids.length === 0) return;

    await Promise.all(
      ids.map((id) =>
        redis.packed.set(
          `${key}:${id}`,
          { [idKey]: id, debounce: true },
          {
            EX: options.debounceTime ?? debounceTime,
          }
        )
      )
    );
    log(`Busted ${ids.length} ${key} items: ${ids.join(', ')}`);
  }

  async function invalidate(id: number | number[], options: { debounceTime?: number } = {}) {
    const ids = Array.isArray(id) ? id : [id];
    if (ids.length === 0) return;

    const cacheResults: T[] = [];
    for (const batch of chunk(ids, 200)) {
      const batchResults = await redis.packed.mGet<T>(
        batch.map((id) => `${key}:${id}` as RedisKeyTemplateCache)
      );
      cacheResults.push(...batchResults.filter(isDefined));
    }

    // Invalidate cache
    const invaliDate = new Date(
      Date.now() - ttl * 1000 + (options.debounceTime ?? debounceTime) * 1000
    );
    const updates = cacheResults.filter(
      (x) => x !== null && 'cachedAt' in x && x.cachedAt !== invaliDate
    ) as T[];
    if (updates.length === 0) return;
    const toCache = Object.fromEntries(
      updates.map((x) => [x[idKey], { ...x, cachedAt: invaliDate }])
    );
    const EX = ttl * 2;
    if (Object.keys(toCache).length > 0)
      await Promise.all(
        Object.entries(toCache).map(([id, cache]) =>
          redis.packed.set(`${key}:${id}`, cache, { EX })
        )
      );

    log(`Invalidated ${ids.length} ${key} items: ${ids.join(', ')}`);
  }

  async function refresh(id: number | number[]) {
    if (!Array.isArray(id)) id = [id];

    const results = await lookupFn(id, true);
    const cachedAt = new Date();
    await Promise.all(
      Object.entries(results).map(
        ([id, x]) => redis.packed.set(`${key}:${id}`, { ...x, cachedAt }),
        {
          EX: ttl,
        }
      )
    );

    const toRemove = id.filter((x) => !results[x]).map(String);
    await Promise.all(toRemove.map((id) => redis.del(`${key}:${id}`)));
  }

  async function flush() {
    await clearCacheByPattern(`${key}:*`);
  }

  return { fetch, bust: staleWhileRevalidate ? invalidate : bust, refresh, flush };
}
export type CachedArray<T extends object> = ReturnType<typeof createCachedArray<T>>;

export function createCachedObject<T extends object>(lookupOptions: CachedLookupOptions<T>) {
  const cachedArray = createCachedArray<T>(lookupOptions);

  async function fetch(ids: number | number[]) {
    if (!Array.isArray(ids)) ids = [ids];
    const results = await cachedArray.fetch(ids);
    return Object.fromEntries(
      results.map((x) => [(x[lookupOptions.idKey] as number | string).toString(), x])
    ) as Record<string, T>;
  }

  return { ...cachedArray, fetch };
}
export type CachedObject<T extends object> = ReturnType<typeof createCachedObject<T>>;

export type CachedCounterOptions = {
  ttl?: number;
};
export function cachedCounter<T extends string | number>(
  rootKey: RedisKeyTemplateCache,
  fetchFn?: (id: T) => Promise<number>,
  { ttl }: CachedCounterOptions = {}
) {
  ttl ??= CacheTTL.hour;
  const counter = {
    async get(id: T) {
      const key = `${rootKey}:${id}` as RedisKeyTemplateCache;
      const cachedCount = Number((await redis.get(key)) ?? 0);
      if (cachedCount) {
        cacheHitCounter.inc({ cache_name: rootKey, cache_type: 'cachedCounter' });
        return cachedCount;
      }

      cacheMissCounter.inc({ cache_name: rootKey, cache_type: 'cachedCounter' });
      const count = (await fetchFn?.(id)) ?? 0;
      await redis.set(key, count, { EX: ttl });
      return count;
    },
    async incrementBy(id: T, amount = 1) {
      const key = `${rootKey}:${id}` as RedisKeyTemplateCache;
      const count = await counter.get(id);
      await redis.incrBy(key, amount);
      return count + amount;
    },
    async clear(id: T) {
      const key = `${rootKey}:${id}` as RedisKeyTemplateCache;
      await redis.del(key);
    },
  };

  return counter;
}

type FetchThroughCacheOptions = {
  ttl?: number;
  lockTTL?: number;
  retryCount?: number;
};
type FetchThroughCacheEntity<T> = { data: T; cachedAt: number };
export async function fetchThroughCache<T>(
  key: RedisKeyTemplateCache,
  fetchFn: () => Promise<T>,
  options: FetchThroughCacheOptions = {}
) {
  const ttl = options.ttl ?? CacheTTL.sm;
  const lockTTL = options.lockTTL ?? 10;
  const retryCount = options.retryCount ?? 3;
  const lockKey = `${REDIS_KEYS.CACHE_LOCKS}:${key}` as const;

  const cachedData = await redis.packed.get<FetchThroughCacheEntity<T>>(key);
  const cachedExpired =
    !cachedData || (cachedData && Date.now() - ttl * 1000 > cachedData.cachedAt);
  if (cachedExpired) {
    // Try to set lock. If already locked, do nothing...
    const gotLock = await redis.setNxKeepTtlWithEx(lockKey, '1', lockTTL);
    if (!gotLock) {
      if (cachedData) return cachedData.data;
      if (retryCount === 0) throw new Error('Failed to fetch data through cache');

      // Wait for the fetcher to do their thing...
      await sleep((lockTTL * 1000) / 2);
      return fetchThroughCache(key, fetchFn, {
        ttl,
        lockTTL,
        retryCount: retryCount - 1,
      });
    }
  } else if (cachedData) return cachedData.data;

  try {
    const data = await fetchFn();
    const toCache: FetchThroughCacheEntity<T> = { data, cachedAt: Date.now() };
    await redis.packed.set(key, toCache, { EX: ttl * 2 });
    return data;
  } finally {
    await redis.del(lockKey);
  }
}

export async function bustFetchThroughCache(key: RedisKeyTemplateCache) {
  const cachedData = await redis.packed.get<FetchThroughCacheEntity<any>>(key);
  if (!cachedData) return;

  const toCache: FetchThroughCacheEntity<any> = { data: cachedData.data, cachedAt: 0 };
  await redis.packed.set(key, toCache, { KEEPTTL: true });
}

export async function clearCacheByPattern(pattern: string) {
  const cleared: string[] = [];

  if (!pattern.includes('*')) {
    await redis.del(pattern as RedisKeyTemplateCache);
    cleared.push(pattern);
    return cleared;
  }

  // Use cluster's scanIterator which handles scanning all nodes
  log('Scanning cache with pattern:', pattern);
  const stream = redis.scanIterator({ MATCH: pattern, COUNT: 10000 });

  for await (const keys of stream) {
    const newKeys = (keys as RedisKeyTemplateCache[]).filter((key) => !cleared.includes(key));
    log('Total keys:', cleared.length, 'Adding:', newKeys.length);
    if (newKeys.length === 0) continue;

    const batches = chunk(newKeys, 10000);
    for (let i = 0; i < batches.length; i++) {
      log('Clearing batch:', i + 1, 'of', batches.length);
      // Delete keys one at a time to avoid CROSSSLOT errors
      await Promise.all(batches[i].map((key) => redis.del(key)));
      cleared.push(...batches[i]);
      log('Cleared batch:', i + 1, 'of', batches.length);
    }
  }

  log('Done clearing cache. Total cleared:', cleared.length);
  return cleared;
}

export async function fetchCacheByPattern(pattern: string) {
  const keysArr: string[] = [];

  // Use cluster's scanIterator which handles scanning all nodes
  log('Fetching cache keys with pattern:', pattern);
  const stream = redis.scanIterator({ MATCH: pattern, COUNT: 10000 });

  for await (const keys of stream) {
    keysArr.push(...(keys as string[]));
    log('Found keys:', keysArr.length);
  }

  log('Done fetching cache keys. Total found:', keysArr.length);
  return keysArr;
}
