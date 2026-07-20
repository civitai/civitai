import { IRedisClient, IClickhouseClient, IDbClient } from '../types/package-stubs';
import { chunk, sleep } from '../utils/basic';

const CACHE_TTL = 24 * 60 * 60; // 24 hours
const MISS_CACHE_TTL = 5 * 60; // 5 minutes
const CACHE_SLIDE_CHANCE = 0.1; // 10% chance of sliding the TTL on each access
const LOCK_DURATION = 2; // 2 seconds lock
const LOCK_RETRY_DELAY = 200; // 200ms delay between retries
const LOCK_MAX_RETRIES = 10; // Maximum number of retry attempts

export type CacheContext = {
  pg: { query: <T = any>(query: string, params?: any[]) => Promise<T[]> };
  ch: { query: <T = any>(query: string, params?: any[]) => Promise<T[]> };
  redis: IRedisClient;
};

export type CacheConfig<T extends object> = {
  redisKey: string; // Prefix for cached items (e.g., 'user:data')
  idKey: keyof T; // Property used as key in result (e.g., 'userId')
  fetch: (ctx: CacheContext, ids: number[]) => Promise<T[]>; // Fetch function returns array
  ttl?: number; // Default cache TTL in seconds
  debounceTime?: number; // Time for writes to propagate to read replicas (default 10s)
  cacheNotFound?: boolean; // Whether to cache "not found" results
  dontCacheFn?: (data: T) => boolean; // Skip caching for certain data
  staleWhileRevalidate?: boolean; // Use background revalidation (default true)
};

type CachedItem<T> = T & {
  cachedAt?: Date;
  notFound?: boolean;
  debounce?: boolean;
};

/**
 * Creates a cache with distributed locking, stale-while-revalidate, and TTL sliding.
 * Based on the cache-helper.md pattern but adapted for the feed system.
 *
 * The fetch function accepts array but returns Record<number, T> for efficient lookups.
 */
export function createCache<T extends object>(config: CacheConfig<T>) {
  const ttl = config.ttl ?? CACHE_TTL;
  const debounceTime = config.debounceTime ?? 10;
  const cacheNotFound = config.cacheNotFound ?? true;
  const staleWhileRevalidate = config.staleWhileRevalidate ?? true;

  /**
   * Fetch items by IDs, using cache when available
   * Returns Record<number, T> for efficient id->value lookups
   */
  async function fetch(ctx: CacheContext, ids: number[]): Promise<Record<number, T>> {
    if (!ids.length) return {};

    const results: Record<number, T> = {};
    const uniqueIds = [...new Set(ids)];
    const cacheMisses: number[] = [];

    // Step 1: Lookup all IDs in Redis
    const cacheKeys = uniqueIds.map((id) => `${config.redisKey}:${id}`);
    const cacheResults: Array<Record<string, string> | null> = [];

    // Batch Redis lookups
    for (const batch of chunk(cacheKeys, 200)) {
      const batchPromises = batch.map((key) => ctx.redis.hGetAll(key));
      const batchResults = await Promise.all(batchPromises);
      cacheResults.push(...batchResults);
    }

    // Step 2: Process cache results
    const slideTTLKeys: string[] = [];
    const cacheDebounceCutoff = new Date(Date.now() - debounceTime * 1000);
    const dontCache = new Set<number>();
    const toRevalidate: Record<number, T> = {};
    const ttlExpiry = new Date(Date.now() - ttl * 1000);

    for (let i = 0; i < uniqueIds.length; i++) {
      const id = uniqueIds[i];
      const cacheResult = cacheResults[i];

      if (cacheResult && Object.keys(cacheResult).length > 0) {
        // Check for "not found" marker
        if (cacheResult.notFound === '1' && Object.keys(cacheResult).length === 1) {
          continue; // Skip not found entries
        }

        // Check for debounce marker
        if (cacheResult.debounce === '1') {
          const cachedAt = cacheResult.cachedAt ? new Date(cacheResult.cachedAt) : new Date(0);
          if (cachedAt > cacheDebounceCutoff) {
            dontCache.add(id);
          }
          cacheMisses.push(id);
          continue;
        }

        // Parse the cached data
        const cachedAt = cacheResult.cachedAt ? new Date(cacheResult.cachedAt) : new Date(0);
        const item: any = {};

        for (const [key, value] of Object.entries(cacheResult)) {
          if (key === 'cachedAt') continue;

          // Try to parse as JSON first (for arrays/objects)
          if (value.startsWith('[') || value.startsWith('{')) {
            try {
              item[key] = JSON.parse(value);
              continue;
            } catch {
              // Not valid JSON, fall through to string/number handling
            }
          }

          // Try to parse as number if it looks like one
          item[key] = isNaN(Number(value)) ? value : Number(value);
        }

        // Check if stale and needs revalidation
        if (staleWhileRevalidate && cachedAt < ttlExpiry) {
          toRevalidate[id] = item as T;
          continue;
        }

        results[id] = item as T;

        // Mark for potential TTL sliding (only for non-notFound entries)
        if (Math.random() < CACHE_SLIDE_CHANCE) {
          slideTTLKeys.push(`${config.redisKey}:${id}`);
        }
      } else {
        cacheMisses.push(id);
      }
    }

    // Step 3: Slide TTLs for hot cache entries
    if (slideTTLKeys.length > 0) {
      try {
        await Promise.all(slideTTLKeys.map((key) => ctx.redis.expire(key, ttl)));
      } catch (error) {
        console.error('TTL sliding failed:', error);
      }
    }

    // Step 4: Handle stale entries with revalidation locks
    const toRevalidateIds = Object.keys(toRevalidate).map(Number);
    if (toRevalidateIds.length > 0) {
      const lockPromises = toRevalidateIds.map((id) => {
        const lockKey = `lock:${config.redisKey}:${id}`;
        return ctx.redis
          .set(lockKey, '1', { NX: true, EX: LOCK_DURATION })
          .then((result) => result === 'OK');
      });

      const gotLocks = await Promise.all(lockPromises);

      for (let i = 0; i < toRevalidateIds.length; i++) {
        const id = toRevalidateIds[i];
        if (!gotLocks[i]) {
          // Someone else is revalidating, return stale data
          results[id] = toRevalidate[id];
          continue;
        }
        // We got the lock, add to cache misses for refetch
        cacheMisses.push(id);
      }
    }

    // Step 5: Handle cache misses with lock mechanism to prevent stampedes
    if (cacheMisses.length > 0) {
      const lockedIds: number[] = [];
      const othersLocked: number[] = [];

      // Try to acquire locks for cache misses
      const lockPromises = cacheMisses.map((id) => {
        const lockKey = `lock:${config.redisKey}:${id}`;
        return ctx.redis
          .set(lockKey, '1', { NX: true, EX: LOCK_DURATION })
          .then((result) => result === 'OK');
      });

      const gotLocks = await Promise.all(lockPromises);

      // Separate IDs we locked vs IDs someone else is fetching
      for (let i = 0; i < cacheMisses.length; i++) {
        if (gotLocks[i]) lockedIds.push(cacheMisses[i]);
        else othersLocked.push(cacheMisses[i]);
      }

      // Fetch data for IDs we successfully locked
      if (lockedIds.length > 0) {
        const fetchBatches = chunk(lockedIds, 10000);
        const allFreshData: T[] = [];

        for (const batch of fetchBatches) {
          const batchData = await config.fetch(ctx, batch);
          allFreshData.push(...batchData);
        }

        // Convert array to map for quick lookup
        const freshDataMap: Record<number, T> = {};
        for (const item of allFreshData) {
          const idValue = item[config.idKey] as unknown as number;
          freshDataMap[idValue] = item;
        }

        // Cache the results and release locks
        const cacheOps: Promise<any>[] = [];
        const cachedAt = new Date();

        for (const id of lockedIds) {
          if (freshDataMap[id]) {
            // Cache found data
            const item = freshDataMap[id];
            if (!dontCache.has(id) && !config.dontCacheFn?.(item)) {
              const toCache: Record<string, string> = { cachedAt: cachedAt.toISOString() };
              for (const [key, value] of Object.entries(item)) {
                // Use JSON.stringify for arrays and objects, String() for primitives
                toCache[key] = Array.isArray(value) || (typeof value === 'object' && value !== null)
                  ? JSON.stringify(value)
                  : String(value);
              }

              const EX = staleWhileRevalidate ? ttl * 2 : ttl;
              cacheOps.push(ctx.redis.hSet(`${config.redisKey}:${id}`, toCache));
              cacheOps.push(ctx.redis.expire(`${config.redisKey}:${id}`, EX));
            }

            results[id] = item;
          } else if (cacheNotFound) {
            // Cache not found with shorter TTL
            cacheOps.push(ctx.redis.hSet(`${config.redisKey}:${id}`, { notFound: '1' }));
            cacheOps.push(ctx.redis.expire(`${config.redisKey}:${id}`, MISS_CACHE_TTL));
          }

          // Release lock
          cacheOps.push(ctx.redis.del(`lock:${config.redisKey}:${id}`));
        }

        await Promise.all(cacheOps);
      }

      // For IDs where someone else has the lock, wait and retry fetching from cache
      let retry = 0;
      while (othersLocked.length > 0 && retry < LOCK_MAX_RETRIES) {
        await sleep(LOCK_RETRY_DELAY);
        retry++;

        // Try to fetch from cache again
        const retryKeys = othersLocked.map((id) => `${config.redisKey}:${id}`);
        const retryResults = await Promise.all(retryKeys.map((key) => ctx.redis.hGetAll(key)));

        // Collect found results
        const found: number[] = [];
        for (let i = 0; i < othersLocked.length; i++) {
          const id = othersLocked[i];
          const cacheResult = retryResults[i];

          if (cacheResult && Object.keys(cacheResult).length > 0) {
            found.push(id);

            // Skip not found entries
            if (cacheResult.notFound === '1') continue;

            // Parse the cached data
            const item: any = {};
            for (const [key, value] of Object.entries(cacheResult)) {
              if (key === 'cachedAt') continue;
              item[key] = isNaN(Number(value)) ? value : Number(value);
            }

            results[id] = item as T;
          }
        }

        // Remove found IDs from waiting list
        for (const id of found) {
          const index = othersLocked.indexOf(id);
          if (index > -1) othersLocked.splice(index, 1);
        }
      }
    }

    return results;
  }

  /**
   * Bust (invalidate) cache entries by ID
   * Sets a debounce marker to prevent immediate refetch
   */
  async function bust(
    ctx: CacheContext,
    id: number | number[],
    options: { debounceTime?: number } = {}
  ): Promise<void> {
    const ids = Array.isArray(id) ? id : [id];
    if (ids.length === 0) return;

    const debounce = options.debounceTime ?? debounceTime;

    await Promise.all(
      ids.map((id) =>
        ctx.redis.hSet(`${config.redisKey}:${id}`, {
          debounce: '1',
          cachedAt: new Date().toISOString(),
        }).then(() =>
          ctx.redis.expire(`${config.redisKey}:${id}`, debounce)
        )
      )
    );
  }

  /**
   * Refresh cache entries by ID
   * Fetches fresh data and updates cache
   */
  async function refresh(ctx: CacheContext, id: number | number[]): Promise<void> {
    const ids = Array.isArray(id) ? id : [id];
    if (ids.length === 0) return;

    const freshData = await config.fetch(ctx, ids);

    // Convert array to map
    const dataMap: Record<number, T> = {};
    for (const item of freshData) {
      const idValue = item[config.idKey] as unknown as number;
      dataMap[idValue] = item;
    }

    const cachedAt = new Date();
    const cacheOps: Promise<any>[] = [];

    for (const id of ids) {
      if (dataMap[id]) {
        const item = dataMap[id];
        const toCache: Record<string, string> = { cachedAt: cachedAt.toISOString() };
        for (const [key, value] of Object.entries(item)) {
          // Use JSON.stringify for arrays and objects, String() for primitives
          toCache[key] = Array.isArray(value) || (typeof value === 'object' && value !== null)
            ? JSON.stringify(value)
            : String(value);
        }

        cacheOps.push(ctx.redis.hSet(`${config.redisKey}:${id}`, toCache));
        cacheOps.push(ctx.redis.expire(`${config.redisKey}:${id}`, ttl));
      } else {
        // Not found, delete from cache
        cacheOps.push(ctx.redis.del(`${config.redisKey}:${id}`));
      }
    }

    await Promise.all(cacheOps);
  }

  return { fetch, bust, refresh };
}

export type Cache<T extends object> = ReturnType<typeof createCache<T>>;
