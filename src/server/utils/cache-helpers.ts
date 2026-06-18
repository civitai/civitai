import type { Prisma, PrismaClient } from '@prisma/client';
import { chunk } from 'lodash-es';
import { CacheTTL } from '~/server/common/constants';
import { logToAxiom } from '~/server/logging/client';
import { cacheHitCounter, cacheMissCounter, cacheRevalidateCounter } from '~/server/prom/client';
import type { RedisKeyTemplateCache, RedisKeyTemplates } from '~/server/redis/client';
import { redis, REDIS_KEYS, sysRedis } from '~/server/redis/client';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';

export type CacheTarget = 'main' | 'sys';

// The clearCacheByPattern* helpers use only the cross-client methods
// (scanIterator, del); typed as `any` here to bridge the cache vs sys key-template
// generics without forcing every caller to know which client they're hitting.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getCacheClient(target: CacheTarget = 'main'): any {
  return target === 'sys' ? sysRedis : redis;
}
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

// Sibling of queryCache for callers that run raw queries through node-postgres
// (pg-pool) instead of Prisma. Same Redis caching semantics, but takes a
// query executor closure that returns rows directly. Used by getAllImages
// where the query is dispatched to one of pgDbWrite | pgDbRead | datapacketDbRead
// based on dual-DB routing logic that we can't push into a Prisma client.
type RawQueryExecutor = <Row>(query: Prisma.Sql) => Promise<Row[]>;
export function queryCacheRaw(executor: RawQueryExecutor, key: string, version?: string) {
  return async function <T extends object[]>(query: Prisma.Sql, options?: cachedQueryOptions) {
    if (options?.ttl === 0) return (await executor<T[number]>(query)) as unknown as T;

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
    const result = (await executor<T[number]>(query)) as unknown as T;
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
    // tagCacheKey writes raw strings via redis.sAdd; read with the same codec.
    // packed.sMembers would msgpack-decode them and throw on every member.
    const keys = await redis.sMembers<RedisKeyTemplateCache>(`${REDIS_KEYS.TAG}:${tag}`);
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
  // Separate TTL for negative-cache markers. When the lookupFn legitimately
  // returns nothing for an id we cache `{ notFound: true }` to skip the work
  // next time — but if the empty result is transient (e.g. async scan/ingest
  // hasn't populated the row yet, or replication lag), caching it for the
  // full ttl pins the bad state. Set this short on caches whose underlying
  // query depends on async-populated columns. Defaults to ttl.
  notFoundTtl?: number;
  dontCacheFn?: (data: T) => boolean;
  staleWhileRevalidate?: boolean;
  // Length (seconds) of the stale-serve tail ADDED beyond the logical `ttl` —
  // the window during which a stale value is served while a background
  // revalidate runs. Defaults to `ttl`, which reproduces the historical
  // `ttl * 2` physical expiry. Only consulted when `staleWhileRevalidate` is
  // true. Shorten it to cut resident memory for caches whose stale tail is far
  // larger than the sub-second revalidation actually needs.
  staleWhileRevalidateTtl?: number;
};
/**
 * Physical Redis EX (seconds) for a cached entry. The logical freshness window
 * is `ttl`; with stale-while-revalidate the key must outlive that by a stale
 * tail so a stale value can be served while a background revalidate runs.
 * The tail defaults to a full `ttl` (historical `ttl * 2` behavior) but can be
 * shortened per-cache via `staleWhileRevalidateTtl` to cut resident memory.
 */
export function resolveCacheExpiry(
  ttl: number,
  staleWhileRevalidate: boolean,
  staleWhileRevalidateTtl?: number
): number {
  if (!staleWhileRevalidate) return ttl;
  return ttl + (staleWhileRevalidateTtl ?? ttl);
}

/**
 * Per-(pod, cache-key, id) single-flight map for the createCachedArray DEGRADED
 * (cluster-read-failed) origin fetch.
 *
 * WHY: when a CLUSTER (cache) Redis read rejects — the #2556 socketTimeout (~10s) or the
 * #2611 command-deadline (REDIS_CLUSTER_COMMAND_TIMEOUT_MS, now 3s) — createCachedArray.fetch
 * fails open to a direct origin (DB) fetch instead of 500ing (its `mGet` had NO try/catch,
 * unlike fetchThroughCache; that surfaced as a 68-min two-pod 500 spike on the hot read paths
 * tag.getAll / user.getCreator / image.getGenerationData on 2026-06-17). But the hot consumers
 * (imageMetaCache / tagIdsForImagesCache, etc.) pass PER-FEED-PAGE id lists, so under a full
 * wedge each distinct page would be a separate origin DB call → a read flood ∝ (pages ×
 * concurrency × ~80 pods): a Redis problem turned into a DB thundering-herd (a worse cascade).
 *
 * This map dedups at INDIVIDUAL-ID granularity: a degraded fetch only DB-looks-up the ids for
 * a given `key` that are NOT already in flight on this pod, and awaits the existing promise
 * for the rest. Because adjacent pages overlap heavily, this collapses OVERLAPPING id-sets
 * (not just identical ones) → per-(key, pod) DB load is bounded by the count of DISTINCT
 * concurrent ids, not by the number of distinct id-sets/pages. No fixed cap → no queue to grow
 * and no caller blocked behind a saturated semaphore. Entries are deleted as soon as their
 * promise settles (success OR error), so the map only ever holds ids currently being fetched
 * — no leak under a sustained wedge. A genuine lookupFn error rejects the shared promise (and
 * is deleted) so it still propagates to every awaiting caller rather than being swallowed.
 *
 * REACHED ONLY on the redis-read-FAILED path (fetchFromOriginDegraded). On the healthy path
 * `mGet` succeeds and this map is never touched — it cannot affect normal traffic or
 * healthy-path latency; it only shapes DB load during a wedge.
 */
const degradedIdInFlight = new Map<string, Promise<unknown>>();

export function createCachedArray<T extends object>({
  key,
  idKey,
  lookupFn,
  appendFn,
  ttl = CacheTTL.xs,
  debounceTime = 10,
  cacheNotFound = true,
  notFoundTtl,
  dontCacheFn,
  staleWhileRevalidate = true,
  staleWhileRevalidateTtl,
}: CachedLookupOptions<T>) {
  // Degraded origin (DB) fetch used when a CLUSTER Redis read rejects. Returns the SAME shape
  // as the healthy `fetch` (decorated by appendFn, cachedAt stripped) but reads nothing from
  // and writes nothing to Redis. DB load is bounded by the per-id single-flight above; a
  // genuine lookupFn error still propagates (the fetch itself is never wrapped — mirrors
  // fetchThroughCache, which never wraps fetchFn).
  async function fetchFromOriginDegraded(distinctIds: number[]): Promise<T[]> {
    // Partition into ids already in flight on this pod (reuse, capturing the promise
    // reference NOW so a concurrent settle+delete can't make us miss it) vs. ids we must
    // originate. byId holds the promise to await for EVERY requested id.
    const byId = new Map<number, Promise<T | undefined>>();
    const toFetch: number[] = [];
    for (const id of distinctIds) {
      const existing = degradedIdInFlight.get(`${key}:${id}`) as Promise<T | undefined> | undefined;
      if (existing) byId.set(id, existing);
      else toFetch.push(id);
    }

    if (toFetch.length > 0) {
      // ONE shared batched lookupFn for all newly-needed ids (same 10000-id cap as the
      // cache-miss path); each id's promise extracts its own record from the shared result.
      const batched = (async () => {
        const dbResults: Record<string, T> = {};
        for (const batch of chunk(toFetch, 10000)) {
          Object.assign(dbResults, await lookupFn([...batch] as number[]));
        }
        return dbResults;
      })();
      for (const id of toFetch) {
        const mapKey = `${key}:${id}`;
        const p = batched.then((r) => r[id]);
        byId.set(id, p);
        degradedIdInFlight.set(mapKey, p);
        // Remove the entry once THIS id settles; guard against clobbering a newer same-id
        // round. .catch keeps the cleanup chain from ever surfacing an unhandledRejection
        // (the rejection is still observed by the Promise.all await below).
        void p
          .finally(() => {
            if (degradedIdInFlight.get(mapKey) === p) degradedIdInFlight.delete(mapKey);
          })
          .catch(() => undefined);
      }
    }

    const settled = await Promise.all(distinctIds.map((id) => byId.get(id) as Promise<T | undefined>));
    // Clone each record before returning it. The per-id single-flight shares ONE object
    // reference across every concurrent caller for that id — but appendFn mutates records IN
    // PLACE (e.g. caches.ts cosmeticCache: `record.id = record.cosmeticId; delete
    // record.cosmeticId`) and we strip cachedAt below. Without a clone, two overlapping
    // degraded fetches would corrupt each other's results. The healthy path is immune (each
    // request decodes its own objects from msgpack); this restores that isolation. Shallow is
    // enough — the appendFns reassign/delete TOP-LEVEL fields.
    const degraded = new Set<T>();
    for (const r of settled) if (r) degraded.add({ ...r } as T);
    if (appendFn) await appendFn(degraded);
    return [...degraded].map((x) => {
      if ('cachedAt' in x) delete x.cachedAt;
      return x;
    });
  }

  async function fetch(ids: number[]) {
    if (!ids.length) return [] as T[];
    const distinctIds = [...new Set(ids)];
    const results = new Set<T>();
    const cacheResults: T[] = [];
    try {
      for (const batch of chunk(distinctIds, 200)) {
        const batchResults = await redis.packed.mGet<T>(
          batch.map((id) => `${key}:${id}` as RedisKeyTemplateCache)
        );
        cacheResults.push(...batchResults.filter(isDefined));
      }
    } catch (err) {
      // CLUSTER Redis READ rejected (cluster stall / socketTimeout / command-deadline). Fail
      // OPEN to a per-id single-flighted origin fetch instead of propagating a 500 on these
      // hot read paths. The lookupFn itself is OUTSIDE this catch (inside
      // fetchFromOriginDegraded), so a genuine DB/logic error still propagates — matches
      // fetchThroughCache, which never wraps fetchFn.
      logSysRedisFailOpen('read-degraded', `createCachedArray mGet (cache cluster) [${key}]`, err, {
        key,
        ids: distinctIds.length,
      });
      return fetchFromOriginDegraded(distinctIds);
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
    for (const id of distinctIds) {
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

      let gotLocks: boolean[];
      try {
        gotLocks = await Promise.all(
          toRevalidateIds.map((id) =>
            redis.setNxKeepTtlWithEx(`${REDIS_KEYS.CACHE_LOCKS}:${key}:${id}`, '1', 10)
          )
        );
      } catch (err) {
        // The revalidate lock is a CLUSTER Redis WRITE; on a cluster error we already hold a
        // fresh-enough stale value for every toRevalidate id, so serve it rather than 500.
        // (Mirrors fetchThroughCache's lock-error path: serve stale if we have it.) Treating
        // every lock as not-acquired skips revalidation this pass — cheap and correct.
        logSysRedisFailOpen(
          'write-degraded',
          `createCachedArray revalidate-lock (cache cluster) [${key}]`,
          err,
          { key, ids: toRevalidateIds.length }
        );
        gotLocks = toRevalidateIds.map(() => false);
      }
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

      // then cache the results. The DB lookup above already SUCCEEDED — a CLUSTER Redis WRITE
      // failure here must NOT turn a good origin fetch into a 500. Swallow it best-effort (the
      // entry just isn't cached this pass); mirrors fetchThroughCache's best-effort set.
      const EX = resolveCacheExpiry(ttl, staleWhileRevalidate, staleWhileRevalidateTtl);
      try {
        if (Object.keys(toCache).length > 0)
          await Promise.all(
            Object.entries(toCache).map(([id, cache]) =>
              redis.packed.set(`${key}:${id}`, cache, { EX })
            )
          );

        // Use NX to avoid overwriting a value with a not found...
        // notFoundTtl lets a caller cap negative-cache lifetime separately from
        // positive results — useful when an empty lookupFn result is likely to
        // be transient (async ingestion, replication lag) rather than truly empty.
        if (Object.keys(toCacheNotFound).length > 0) {
          const notFoundEX = notFoundTtl ?? EX;
          await Promise.all(
            Object.entries(toCacheNotFound).map(([id, cache]) =>
              redis.packed.set(`${key}:${id}`, cache, { EX: notFoundEX, NX: true })
            )
          );
        }
      } catch (err) {
        logSysRedisFailOpen('write-degraded', `createCachedArray set (cache cluster) [${key}]`, err, {
          key,
        });
      }
    }

    // Remove locks (best-effort: a failed del just leaves the lock to expire via its 10s TTL
    // — never let it mask the successful fetch result or 500 the request).
    if (locks.size > 0)
      await redis.del([...locks]).catch((err) =>
        logSysRedisFailOpen('write-degraded', `createCachedArray del-locks (cache cluster) [${key}]`, err, {
          key,
        })
      );

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
    // invalidate is only wired up when staleWhileRevalidate is true (see the
    // returned `bust`), so resolve the tail with SWR=true to honor any trim.
    const EX = resolveCacheExpiry(ttl, true, staleWhileRevalidateTtl);
    if (Object.keys(toCache).length > 0)
      await Promise.all(
        Object.entries(toCache).map(([id, cache]) =>
          redis.packed.set(`${key}:${id}`, cache, { EX })
        )
      );

    log(`Invalidated ${ids.length} ${key} items: ${ids.join(', ')}`);
  }

  async function refresh(id: number | number[]) {
    const ids = Array.isArray(id) ? id : [id];

    try {
      const results = await lookupFn(ids, true);
      // appendFn is a read-side decorator (attaches computed fields, may mutate
      // records in place). refresh() is fire-and-forget — its output isn't
      // returned to a caller — so running appendFn here only risks persisting
      // post-mutation shape to Redis. Leave it to fetch().
      const cachedAt = new Date();
      const EX = resolveCacheExpiry(ttl, staleWhileRevalidate, staleWhileRevalidateTtl);
      await Promise.all(
        Object.entries(results).map(([rid, x]) =>
          redis.packed.set(`${key}:${rid}`, { ...x, cachedAt }, { EX })
        )
      );

      const toRemove = ids.filter((x) => !results[x]).map(String);
      await Promise.all(toRemove.map((rid) => redis.del(`${key}:${rid}`)));
    } catch (error) {
      // Refresh is best-effort: swallow and fall back to bust semantics so the
      // next reader re-fetches from primary via lookupFn. A committed mutation
      // must not surface a 500 just because the cache refill failed.
      logToAxiom(
        {
          type: 'error',
          name: 'cache-refresh-failed',
          cacheKey: key,
          ids: ids.join(','),
          error: error instanceof Error ? error.message : String(error),
        },
        'civitai-prod'
      ).catch(() => undefined);
      const fallbackBust = staleWhileRevalidate ? invalidate : bust;
      await fallbackBust(ids).catch(() => undefined);
    }
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

/**
 * Per-pod (per-process) single-flight map for the fail-open path ONLY.
 *
 * fetchThroughCache normally prevents an origin (DB/ClickHouse) stampede with a
 * REDIS-backed distributed lock: only the lock-winner runs `fetchFn`, everyone else
 * serves stale or waits. But that lock lives IN Redis — so when Redis itself stalls
 * (the PR #2556 socketTimeout now turns a stalled read into a ~10s throw instead of a
 * 30s-504), the lock is unreachable and the cross-pod single-flight is GONE. Several
 * fetchThroughCache `fetchFn`s are expensive DB/ClickHouse aggregations (buzz pool
 * SUM scans, featured-models, mod-rules, creator-program pool math). Naively
 * catch-and-call-fetchFn on every request across ~80 pods would convert a Redis
 * problem into a DB thundering-herd — a worse cascade.
 *
 * This map degrades that gracefully: during a Redis outage, concurrent requests for
 * the SAME key on the SAME pod share ONE in-flight `fetchFn()` promise. That bounds
 * origin load to ≤ (distinct keys × pods) concurrent origin calls instead of
 * unbounded (× per-request concurrency). It is NOT cross-pod (that's what the Redis
 * lock was for and Redis is down), but it removes the per-pod multiplier, which is the
 * dominant term under a request flood. Entries are deleted as soon as the shared
 * promise settles, so the map only ever holds currently-degraded keys.
 */
const failOpenInFlight = new Map<string, Promise<unknown>>();

function fetchThroughCacheFailOpen<T>(key: string, fetchFn: () => Promise<T>): Promise<T> {
  const existing = failOpenInFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  // Promise.resolve().then(fetchFn) so even a SYNCHRONOUS throw inside fetchFn becomes
  // a rejected promise — guaranteeing the .finally cleanup runs and the map entry is
  // always removed (no leaked/stuck in-flight entry).
  const p = Promise.resolve().then(fetchFn).finally(() => {
    failOpenInFlight.delete(key);
  });
  failOpenInFlight.set(key, p);
  return p;
}

export async function fetchThroughCache<T>(
  key: RedisKeyTemplateCache,
  fetchFn: () => Promise<T>,
  options: FetchThroughCacheOptions = {}
) {
  const ttl = options.ttl ?? CacheTTL.sm;
  const lockTTL = options.lockTTL ?? 10;
  const retryCount = options.retryCount ?? 3;
  const lockKey = `${REDIS_KEYS.CACHE_LOCKS}:${key}` as const;

  // --- Redis READ (cache lookup) -------------------------------------------------
  // With the socketTimeout fix a stalled Redis read now THROWS (~10s) instead of
  // hanging to the 30s Traefik 504. Fail OPEN: degrade to a slow-but-working origin
  // fetch (single-flighted per pod to avoid a DB stampede — see failOpenInFlight)
  // rather than propagating a 500 on these ~18 hot read paths. This is strictly no
  // worse than today's behavior on the same paths (a Redis stall already meant a
  // failed request); it just turns the failure mode from 500/504 into a slow 200.
  let cachedData: FetchThroughCacheEntity<T> | null;
  try {
    cachedData = await redis.packed.get<FetchThroughCacheEntity<T>>(key);
  } catch (err) {
    logSysRedisFailOpen('read-degraded', 'fetchThroughCache get (cache cluster)', err, { key });
    return fetchThroughCacheFailOpen(key, fetchFn);
  }

  const cachedExpired =
    !cachedData || (cachedData && Date.now() - ttl * 1000 > cachedData.cachedAt);
  if (cachedExpired) {
    // --- Redis LOCK (stampede guard) ---------------------------------------------
    // Try to set lock. If already locked, do nothing...
    let gotLock: boolean;
    try {
      gotLock = await redis.setNxKeepTtlWithEx(lockKey, '1', lockTTL);
    } catch (err) {
      // Lock acquisition itself hit a Redis error. We still have a fresh-enough
      // intent to refresh, but the distributed lock is unavailable. Serve stale if we
      // have it (cheapest, fully correct); otherwise fail open to a single-flighted
      // origin fetch (per-pod bounded) instead of throwing a 500.
      logSysRedisFailOpen('read-degraded', 'fetchThroughCache lock (cache cluster)', err, { key });
      if (cachedData) return cachedData.data;
      return fetchThroughCacheFailOpen(key, fetchFn);
    }
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

  // We hold the lock (or there is no lock contention): run the origin fetch and try
  // to populate the cache. The fetch itself is NOT wrapped — a genuine fetchFn error
  // is a real error and must propagate as before. Only the best-effort Redis writes
  // (set result, release lock) are swallowed so a Redis stall on the WRITE side never
  // turns a successful origin fetch into a 500.
  try {
    const data = await fetchFn();
    const toCache: FetchThroughCacheEntity<T> = { data, cachedAt: Date.now() };
    try {
      await redis.packed.set(key, toCache, { EX: ttl * 2 });
    } catch (err) {
      logSysRedisFailOpen('write-degraded', 'fetchThroughCache set (cache cluster)', err, { key });
    }
    return data;
  } finally {
    // Best-effort lock release; a failure here just leaves the lock to expire via its
    // TTL (lockTTL). Never let it mask the fetch result or throw.
    try {
      await redis.del(lockKey);
    } catch (err) {
      logSysRedisFailOpen('write-degraded', 'fetchThroughCache del-lock (cache cluster)', err, {
        key,
      });
    }
  }
}

export async function bustFetchThroughCache(key: RedisKeyTemplateCache) {
  const cachedData = await redis.packed.get<FetchThroughCacheEntity<any>>(key);
  if (!cachedData) return;

  const toCache: FetchThroughCacheEntity<any> = { data: cachedData.data, cachedAt: 0 };
  await redis.packed.set(key, toCache, { KEEPTTL: true });
}

/**
 * ⚠️ DANGER — DO NOT call on a hot path (per-request / per-mutation cache busts).
 *
 * With a wildcard pattern this runs a CLUSTER-WIDE `SCAN` (every node, O(total
 * keyspace)). SCAN is slow and effectively head-of-line-blocking on Redis's
 * single thread; on a large or memory-pressured shard one call can take seconds
 * and TIME OUT every other command on that node.
 *
 * Incident 2026-06-08 (civitai #2434): the buzz-balance cache busted via
 * `clearCacheByPattern('buzz:account:<id>:*')` on EVERY buzz mutation. Each one
 * triggered a cluster SCAN over a ~60M-key shard → redis command timeouts →
 * request pileup → API main-thread CPU pin / 504 waves. It had to be reverted.
 *
 * ✅ For bust-on-write/mutation, NEVER scan. Record the keys you wrote in a
 * per-entity index SET (`sAdd` on cache write, short TTL) and bust with
 * `sMembers` + targeted `del` — see `bustQueriedWorkflowsCache` in
 * `services/orchestrator/orchestration-new.service.ts` (#2436) for the pattern.
 *
 * ✅ Acceptable uses: RARE / admin / global operations only (the admin
 * cache-clear endpoint, mass session invalidation, one-off legacy-key cleanup).
 * Never on a path that runs per request, per mutation, or in a tight loop.
 */
export async function clearCacheByPattern(
  pattern: string,
  onProgress?: (cleared: number) => void,
  target: CacheTarget = 'main'
) {
  const client = getCacheClient(target);
  const cleared: string[] = [];

  if (!pattern.includes('*')) {
    await client.del(pattern);
    cleared.push(pattern);
    onProgress?.(cleared.length);
    return cleared;
  }

  // Use cluster's scanIterator which handles scanning all nodes
  log('Scanning cache with pattern:', pattern, 'target:', target);
  const stream = client.scanIterator({ MATCH: pattern, COUNT: 10000 });

  for await (const keys of stream) {
    const newKeys = (keys as RedisKeyTemplates[]).filter((key) => !cleared.includes(key));
    log('Total keys:', cleared.length, 'Adding:', newKeys.length);
    if (newKeys.length === 0) continue;

    const batches = chunk(newKeys, 10000);
    for (let i = 0; i < batches.length; i++) {
      log('Clearing batch:', i + 1, 'of', batches.length);
      // Delete keys one at a time to avoid CROSSSLOT errors on the main cluster.
      await Promise.all(batches[i].map((key) => client.del(key)));
      cleared.push(...batches[i]);
      log('Cleared batch:', i + 1, 'of', batches.length);
      onProgress?.(cleared.length);
    }
  }

  log('Done clearing cache. Total cleared:', cleared.length);
  return cleared;
}

function globToRegex(pattern: string) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$');
}

export type ClearCacheByPatternsProgress = {
  total: number;
  perPattern: { pattern: string; cleared: number }[];
};

// Single-pass purge across multiple patterns — iterates the keyspace once and
// tests each key against every pattern regex. Replaces N full SCANs with 1.
// ⚠️ Still a CLUSTER-WIDE SCAN — same hot-path danger as `clearCacheByPattern`
// above (see its doc + the 2026-06-08 #2434 incident). Admin/rare/global only.
export async function clearCacheByPatterns(
  patterns: string[],
  onProgress?: (progress: ClearCacheByPatternsProgress) => void,
  target: CacheTarget = 'main'
) {
  const client = getCacheClient(target);
  const perPattern = patterns.map((pattern) => ({
    pattern,
    regex: globToRegex(pattern),
    cleared: [] as string[],
  }));

  const exact = perPattern.filter((p) => !p.pattern.includes('*'));
  const globbed = perPattern.filter((p) => p.pattern.includes('*'));

  // Fast path for exact keys — no scan needed.
  for (const p of exact) {
    await client.del(p.pattern as RedisKeyTemplates);
    p.cleared.push(p.pattern);
  }

  if (globbed.length > 0) {
    log('Scanning cache for', globbed.length, 'patterns in a single pass, target:', target);
    const stream = client.scanIterator({ MATCH: '*', COUNT: 10000 });

    for await (const keys of stream) {
      const toDelete: RedisKeyTemplates[] = [];
      for (const key of keys as RedisKeyTemplates[]) {
        for (const p of globbed) {
          if (p.regex.test(key)) {
            p.cleared.push(key);
            toDelete.push(key);
            break;
          }
        }
      }
      if (toDelete.length === 0) continue;

      const batches = chunk(toDelete, 10000);
      for (const batch of batches) {
        await Promise.all(batch.map((key) => client.del(key)));
      }
      const total = perPattern.reduce((s, p) => s + p.cleared.length, 0);
      onProgress?.({
        total,
        perPattern: perPattern.map((p) => ({ pattern: p.pattern, cleared: p.cleared.length })),
      });
    }
  } else {
    const total = perPattern.reduce((s, p) => s + p.cleared.length, 0);
    onProgress?.({
      total,
      perPattern: perPattern.map((p) => ({ pattern: p.pattern, cleared: p.cleared.length })),
    });
  }

  return perPattern.map((p) => ({ pattern: p.pattern, cleared: p.cleared.length }));
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
