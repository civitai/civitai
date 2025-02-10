import { Prisma, PrismaClient } from '@prisma/client';
import { chunk } from 'lodash-es';
import { createClient } from 'redis';
import { env } from '~/env/server';
import { CacheTTL } from '~/server/common/constants';
import { redis, REDIS_KEYS, RedisKeyTemplateCache, RedisKeyTemplates } from '~/server/redis/client';
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
    if (cachedData && options?.ttl !== 0) return cachedData ?? ([] as unknown as T);

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
}: CachedLookupOptions<T>) {
  async function fetch(ids: number[]) {
    if (!ids.length) return [];
    const results = new Set<T>();
    const cacheResults: T[] = [];
    for (const batch of chunk(ids, 200)) {
      const batchResults = await redis.packed.mGet<T>(
        batch.map((id) => `${key}:${id}` as RedisKeyTemplateCache)
      );
      cacheResults.push(...batchResults.filter(isDefined));
    }
    const cacheArray = cacheResults.filter((x) => x !== null) as T[];
    const cache = Object.fromEntries(
      cacheArray.map((x) => {
        if ('cachedAt' in x) delete x.cachedAt;
        return [x[idKey], x];
      })
    );

    const cacheDebounceCutoff = new Date(Date.now() - debounceTime * 1000);
    const cacheMisses = new Set<number>();
    const dontCache = new Set<number>();
    for (const id of [...new Set(ids)]) {
      const cached = cache[id];
      if (cached) {
        if (cached.notFound) continue;
        if (cached.debounce) {
          if (cached.cachedAt > cacheDebounceCutoff) dontCache.add(id);
          cacheMisses.add(id);
          continue;
        }
        results.add(cached);
      } else cacheMisses.add(id);
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
      for (const id of cacheMisses) {
        const result = dbResults[id];
        if (!result) {
          if (cacheNotFound) toCacheNotFound[id] = { [idKey]: id, notFound: true, cachedAt };
          continue;
        }
        results.add(result as T);
        if (!dontCache.has(id) && !dontCacheFn?.(result)) toCache[id] = { ...result, cachedAt };
      }

      // then cache the results
      if (Object.keys(toCache).length > 0)
        await Promise.all(
          Object.entries(toCache).map(([id, cache]) =>
            redis.packed.set(`${key}:${id}`, cache, { EX: ttl })
          )
        );

      // Use NX to avoid overwriting a value with a not found...
      if (Object.keys(toCacheNotFound).length > 0)
        await Promise.all(
          Object.entries(toCacheNotFound).map(([id, cache]) =>
            redis.packed.set(`${key}:${id}`, cache, { EX: ttl, NX: true })
          )
        );
    }

    if (appendFn) await appendFn(results);

    return [...results];
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

  return { fetch, bust, refresh };
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
      if (cachedCount) return cachedCount;

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

  if (!env.REDIS_URL_DIRECT || env.REDIS_URL_DIRECT.length === 0) {
    console.log('No redis url found, skipping cache clear');
    return cleared;
  }

  await Promise.all(
    env.REDIS_URL_DIRECT.map(async (url) => {
      let cursor: number | undefined;
      const redis = createClient({
        url,
        socket: {
          reconnectStrategy(retries) {
            log(`Redis reconnecting, retry ${retries}`);
            return Math.min(retries * 100, 3000);
          },
          connectTimeout: env.REDIS_TIMEOUT,
        },
        pingInterval: 4 * 60 * 1000,
      });
      console.log(`Connecting to redis: ${url}`);

      try {
        await redis.connect();
        while (cursor !== 0) {
          console.log('Scanning:', cursor);
          const reply = await redis.scan(cursor ?? 0, {
            MATCH: pattern,
            COUNT: 10000000,
          });

          cursor = reply.cursor;
          const keys = reply.keys as unknown as RedisKeyTemplateCache[];
          const newKeys = keys.filter((key) => !cleared.includes(key));
          console.log('Total keys:', cleared.length, 'Adding:', newKeys.length, 'Cursor:', cursor);
          if (newKeys.length === 0) continue;

          const batches = chunk(newKeys, 10000);
          for (let i = 0; i < batches.length; i++) {
            console.log('Clearing:', i, 'Of', batches.length);
            await redis.del(batches[i]);
            cleared.push(...batches[i]);
            console.log('Cleared:', i, 'Of', batches.length);
          }
          console.log('Cleared:', cleared.length);
          console.log('Cursor:', cursor);
        }
        console.log('Done clearing cache');
      } finally {
        await redis.quit();
      }
    })
  );

  return cleared;
}
