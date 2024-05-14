import { Prisma, PrismaClient } from '@prisma/client';
import { CacheTTL } from '~/server/common/constants';
import { redis } from '~/server/redis/client';
import { fromJson, toJson } from '~/utils/json-helpers';
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

    const cacheKey = [key, version, hashifyObject(query).toString()].filter(isDefined).join(':');
    const cachedData = await redis.get(cacheKey);
    if (cachedData && options?.ttl !== 0) return fromJson<T>(cachedData) ?? ([] as unknown as T);

    const result = await db.$queryRaw<T>(query);
    await redis.set(cacheKey, toJson(result), { EX: options?.ttl });

    if (options?.tag) await tagCacheKey(cacheKey, options?.tag);
    return result;
  };
}

async function tagCacheKey(key: string, tag: string | string[]) {
  const tags = Array.isArray(tag) ? tag : [tag];
  for (const tag of tags) {
    await redis.sAdd(`tag:${tag}`, key);
  }
}

export async function bustCacheTag(tag: string | string[]) {
  const tags = Array.isArray(tag) ? tag : [tag];
  for (const tag of tags) {
    const keys = await redis.sMembers(`tag:${tag}`);
    for (const key of keys) await redis.del(key);
    await redis.del(`tag:${tag}`);
  }
}

type CachedLookupOptions<T extends object> = {
  key: string;
  idKey: keyof T;
  lookupFn: (ids: number[], fromWrite?: boolean) => Promise<Record<string, object>>;
  appendFn?: (results: Set<T>) => Promise<void>;
  ttl?: number;
  debounceTime?: number;
  cacheNotFound?: boolean;
};
export function createCachedArray<T extends object>({
  key,
  idKey,
  lookupFn,
  appendFn,
  ttl = CacheTTL.xs,
  debounceTime = 10,
  cacheNotFound = true,
}: CachedLookupOptions<T>) {
  async function fetch(ids: number[]) {
    if (!ids.length) return [];
    const results = new Set<T>();
    const cacheJsons = await Promise.all(ids.map((id) => redis.get(`${key}:${id}`)));
    const cacheArray = cacheJsons.filter((x) => x !== null).map((x) => JSON.parse(x ?? '{}'));
    const cache = Object.fromEntries(cacheArray.map((x) => [x[idKey], x]));

    const cacheDebounceCutoff = Date.now() - debounceTime * 1000;
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
      const dbResults = await lookupFn([...cacheMisses] as typeof ids);

      const toCache: Record<string, string> = {};
      const toCacheNotFound: Record<string, string> = {};
      const cachedAt = Date.now();
      for (const id of cacheMisses) {
        const result = dbResults[id];
        if (!result) {
          if (cacheNotFound)
            toCacheNotFound[id] = JSON.stringify({ [idKey]: id, notFound: true, cachedAt });
          continue;
        }
        results.add(result as T);
        if (!dontCache.has(id)) toCache[id] = JSON.stringify({ ...result, cachedAt });
      }

      // then cache the results
      if (Object.keys(toCache).length > 0)
        await Promise.all(
          Object.entries(toCache).map(([id, cache]) =>
            redis.set(`${key}:${id}`, cache, { EX: ttl })
          )
        );

      // Use NX to avoid overwriting a value with a not found...
      if (Object.keys(toCacheNotFound).length > 0)
        await Promise.all(
          Object.entries(toCacheNotFound).map(([id, cache]) => {
            return Promise.all([
              redis.setNX(`${key}:${id}`, cache),
              redis.expire(`${key}:${id}`, ttl),
            ]);
          })
        );
    }

    if (appendFn) await appendFn(results);

    return [...results];
  }

  async function bust(id: number | number[]) {
    const ids = Array.isArray(id) ? id : [id];
    if (ids.length === 0) return;

    await Promise.all(
      ids.map((id) => redis.set(`${key}:${id}`, JSON.stringify({ [idKey]: id, debounce: true })))
    );
    log(`Busted ${ids.length} ${key} items: ${ids.join(', ')}`);
  }

  async function refresh(id: number | number[]) {
    if (!Array.isArray(id)) id = [id];

    const results = await lookupFn(id, true);
    await Promise.all(
      Object.entries(results).map(([key, x]) => redis.set(`${key}:${key}`, JSON.stringify(x)))
    );

    const toRemove = id.filter((x) => !results[x]).map(String);
    await Promise.all(toRemove.map((id) => redis.del(`${key}:${id}`)));
  }

  return { fetch, bust, refresh };
}
export type CachedArray<T extends object> = ReturnType<typeof createCachedArray<T>>;

export function createCachedObject<T extends object>(lookupOptions: CachedLookupOptions<T>) {
  const cachedArray = createCachedArray<T>(lookupOptions);

  async function fetch(ids: number[]) {
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
  rootKey: string,
  fetchFn?: (id: T) => Promise<number>,
  { ttl }: CachedCounterOptions = {}
) {
  ttl ??= CacheTTL.hour;
  const counter = {
    async get(id: T) {
      const key = `${rootKey}:${id}`;
      const cachedCount = Number((await redis.get(key)) ?? 0);
      if (cachedCount) return cachedCount;

      const count = (await fetchFn?.(id)) ?? 0;
      await redis.set(key, count, { EX: ttl });
      return count;
    },
    async incrementBy(id: T, amount = 1) {
      const key = `${rootKey}:${id}`;
      const count = await counter.get(id);
      await redis.incrBy(key, amount);
      return count + amount;
    },
    async clear(id: T) {
      const key = `${rootKey}:${id}`;
      await redis.del(key);
    },
  };

  return counter;
}
