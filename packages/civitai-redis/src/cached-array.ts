// Batched per-id read-through cache (`fetch(ids[]) -> T[]` / `-> Record<id, T>`), with
// stale-while-revalidate, negative caching, a debounce window, an optional per-pod L1, and fail-open
// behavior on every Redis error. Distinct from ./cache, which is single-key read-through — this shape
// exists so a caller can hydrate hundreds of ids in one pass.
//
// Everything app-specific (metrics, logging, the L1 factory, pattern-clearing) is INJECTED via
// createCacheBuilders rather than imported, so this module stays free of app env/logging/prom deps —
// and so app-level test mocks of the redis client still intercept.
import { chunk } from 'lodash-es';
import { REDIS_KEYS, type RedisKeyTemplateCache } from './client';
import { createLruCache } from './lru-cache';

type AnyRecord = Record<string, any>;

const isDefined = <T>(x: T | null | undefined): x is T => x !== null && x !== undefined;

export type CachedLookupOptions<T extends object> = {
  key: RedisKeyTemplateCache;
  idKey: keyof T;
  lookupFn: (ids: number[], fromWrite?: boolean) => Promise<Record<string, T>>;
  appendFn?: (results: Set<T>) => Promise<void>;
  ttl?: number;
  debounceTime?: number;
  cacheNotFound?: boolean;
  // Separate TTL for negative-cache markers. When the lookupFn legitimately returns nothing for an id
  // we cache `{ notFound: true }` to skip the work next time — but if the empty result is transient
  // (async scan/ingest hasn't populated the row yet, or replication lag), caching it for the full ttl
  // pins the bad state. Set this short on caches whose query depends on async-populated columns.
  notFoundTtl?: number;
  dontCacheFn?: (data: T) => boolean;
  staleWhileRevalidate?: boolean;
  // Length (seconds) of the stale-serve tail ADDED beyond the logical `ttl` — the window during which
  // a stale value is served while a background revalidate runs. Defaults to `ttl`, reproducing the
  // historical `ttl * 2` physical expiry. Only consulted when `staleWhileRevalidate` is true.
  staleWhileRevalidateTtl?: number;
  // --- In-process (per-pod) L1 in front of the Redis per-id cache -----------------------------------
  // Opt-in. When `localTtl` (SECONDS) is set, resolved per-id values are also held in a bounded per-pod
  // LRU. An L1 hit skips the ENTIRE Redis GET fan-out for that id — the win on hot feed hydration,
  // where packed.mGet decomposes into per-id GETs (no MGET across cluster slots).
  //
  // 🔴 CORRECTNESS: the L1 is per-pod and CANNOT see a cross-pod `bust`/`refresh`, so a mutation
  // propagates with up to `localTtl` extra staleness on pods holding a copy. Enable ONLY on near-static
  // per-entity caches whose Redis TTL already tolerates far more staleness than `localTtl` adds, AND
  // that do not gate content visibility / auth. Keep `localTtl` SHORT (5–30s) and strictly < the Redis
  // `ttl`. Only positive results are L1-cached, so the L1 never pins a negative.
  localTtl?: number;
  // Belt-and-suspenders ENTRY cap for the per-pod L1 (default 10000).
  localMax?: number;
  // 🔴 HARD HEAP CAP: byte budget for this cache's L1. Set this on every L1-enabled cache so the pod's
  // total L1 footprint is bounded regardless of per-value size spikes. A single value larger than the
  // budget is simply not stored (falls through to Redis) — never an error.
  localMaxBytes?: number;
  // Opt-in brotli compression of the packed value at rest (sentinel-tagged). Enable only for caches
  // whose values are LARGE and repetitive enough to pay the codec — most per-id values are tiny.
  //
  // 🔴 Every redis.packed READ in this builder must pass `{ compress }` (via packedOptions): a
  // compressed value read through the general msgpack path throws → the entry is EVICTED and
  // reported as a miss — a silent permanent miss+evict loop. Writes may skip compression (fetch's
  // not-found marker does): the compress-aware read passes any non-sentinel value straight to
  // msgpack. invalidate() rewrites the records and not-found markers it reads, compressed.
  //
  // Back-compat is free in BOTH directions: the compress-aware read is sentinel-discriminated, so
  // legacy uncompressed entries written before the flag was flipped still decode. No key-bust or
  // migration is needed to turn this on. (Turning it OFF again is NOT symmetric — see the note on
  // the general decode path in ./packed-compression — so flip it off only with a key-bust.)
  //
  // SENTINEL SAFETY: every value this module writes is an object (`{ ...result, cachedAt }`, the
  // notFound marker, the debounce marker) and `T extends object`, so the 0x01 sentinel can never
  // collide with a bare-scalar msgpack payload. See ./packed-compression.
  compress?: boolean;
};

/** Per-call options for `fetch`. */
export type CachedFetchOptions = {
  /**
   * `false` makes this call read-only against Redis: hits (Redis or L1) are served as usual,
   * misses go to `lookupFn` and are returned without being cached, and stale entries are served
   * as-is instead of being revalidated. It writes no L1 either, except on the degraded path (see
   * backfillLocal).
   *
   * Misses still count in the miss metric, so a cache read this way can show a higher miss ratio
   * while writing less; judge the effect by write volume, not miss ratio.
   *
   * For callers whose ids are unlikely to be read again soon (e.g. a cold back-catalogue walk),
   * where the write only costs memory.
   */
  writeBack?: boolean;
};

/** The slice of the redis client this module needs. */
type PackedClient = {
  packed: {
    mGet<T>(
      keys: RedisKeyTemplateCache[],
      packedOptions?: { compress?: boolean; cacheName?: string }
    ): Promise<(T | null)[]>;
    set<T>(
      key: RedisKeyTemplateCache,
      value: T,
      options?: { EX?: number; NX?: boolean; XX?: boolean },
      packedOptions?: { compress?: boolean; cacheName?: string }
    ): Promise<unknown>;
  };
  del(key: RedisKeyTemplateCache | RedisKeyTemplateCache[]): Promise<unknown>;
  setNxKeepTtlWithEx(key: RedisKeyTemplateCache, value: string, ttl: number): Promise<boolean>;
};

export type CacheBuilderDeps = {
  redis: PackedClient;
  /** Default `ttl` when a cache doesn't specify one (the app passes CacheTTL.xs). */
  defaultTtl: number;
  metrics: {
    hit(cacheName: string, cacheType: string, count: number): void;
    miss(cacheName: string, cacheType: string, count: number): void;
    revalidate(cacheName: string, cacheType: string, count: number): void;
    failOpenDegraded(cacheName: string): void;
    failOpenOriginFetch(cacheName: string, count: number): void;
    /**
     * Miss-fill lookups that per-process coalescing (PR #5488) would have JOINED instead of
     * running: the id was registered by another fetch in THIS process (same cache) whose lookup
     * started under MISS_FILL_JOIN_MAX_MS ago and has not settled with its writes, it is not a
     * debounce-marker id, and no bust/invalidate/refresh/update detached it since. An upper
     * bound (the excess is unmeasured): an originator here stays registered while it also looks up
     * and writes the ids it would have joined, and writes values then markers in sequence, so its
     * entries live longer than in #5488 — the more so the larger its combined batch. Measurement
     * only: the lookup and its writes still happen. Cross-process duplicates are not visible here.
     */
    missWouldJoin(cacheName: string, count: number): void;
  };
  /** Structured log for a fail-open Redis degradation (the app's logSysRedisFailOpen). */
  logFailOpen(
    kind: 'read-degraded' | 'write-degraded',
    message: string,
    error: unknown,
    meta: AnyRecord
  ): void;
  /** Reported when a refresh() fails and falls back to bust semantics. */
  logRefreshError(payload: { cacheKey: string; ids: string; error: string }): void;
  /** Debug logger. */
  log(...args: unknown[]): void;
  /** Backs flush(); the app owns pattern scanning (it is cluster- and target-aware). */
  clearByPattern(pattern: string): Promise<unknown>;
};

/**
 * Physical Redis EX (seconds) for a cached entry. The logical freshness window is `ttl`; with
 * stale-while-revalidate the key must outlive that by a stale tail so a stale value can be served
 * while a background revalidate runs. The tail defaults to a full `ttl` (historical `ttl * 2`).
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
 * Per-(pod, cache-key, id) single-flight map for the DEGRADED (cluster-read-failed) origin fetch.
 *
 * WHY: when a CLUSTER read rejects, fetch fails open to a direct origin (DB) fetch instead of 500ing.
 * But hot consumers pass PER-FEED-PAGE id lists, so under a full wedge each distinct page would be a
 * separate origin call → a read flood ∝ (pages × concurrency × pods): a Redis problem turned into a DB
 * thundering-herd. This map dedups at INDIVIDUAL-ID granularity, so per-(key, pod) DB load is bounded
 * by the count of DISTINCT concurrent ids rather than the number of distinct id-sets. Entries are
 * deleted as soon as their promise settles (success OR error), so it never leaks under a sustained
 * wedge. REACHED ONLY on the redis-read-FAILED path — it cannot affect healthy-path latency.
 *
 * Scoped PER BUILDER, not per module: the map is keyed `${key}:${id}`, so two builders holding caches
 * with the same `key` but different `lookupFn`s would otherwise hand each other's rows back during a
 * degraded fetch.
 */
/** Seconds a write-through `update` holds its per-entry lock. Bounds one GET + one SET. */
const UPDATE_LOCK_TTL = 5;

/**
 * A registered lookup at least this old is not counted as joinable (and is replaced). Mirrors
 * IN_FLIGHT_JOIN_MAX_MS in the coalescing proposal (#5488) so missWouldJoin counts what it would
 * join; change both together.
 */
const MISS_FILL_JOIN_MAX_MS = 10_000;
type MissFillEntry = { startedAt: number };

export function createCacheBuilders(deps: CacheBuilderDeps) {
  const { redis, metrics, logFailOpen, logRefreshError, log, clearByPattern } = deps;
  const degradedIdInFlight = new Map<string, Promise<unknown>>();

  function createCachedArray<T extends object>({
    key,
    idKey,
    lookupFn,
    appendFn,
    ttl = deps.defaultTtl,
    debounceTime = 10,
    cacheNotFound = true,
    notFoundTtl,
    dontCacheFn,
    staleWhileRevalidate = true,
    staleWhileRevalidateTtl,
    localTtl,
    localMax = 10000,
    localMaxBytes,
    compress = false,
  }: CachedLookupOptions<T>) {
    // Resolved ONCE and passed to every redis.packed call below except the not-found marker's
    // (notFoundPackedOptions), so no READ can miss the compress flag.
    // `cacheName` rides along on the same binding: it is the `cache_name` label on the codec
    // duration histogram, and `key` is exactly the value this module already reports to
    // metrics.hit/miss as cache_name — one scheme, not two. Bounded by construction (it is the
    // cache prefix, not `${key}:${id}`), and observational only.
    const packedOptions = { compress, cacheName: key } as const;
    // Not-found markers skip compression even on a compress:true cache: a tiny map gains nothing,
    // and the compress-aware read passes a non-sentinel value (a msgpack map never starts with
    // 0x01) straight to msgpack. See ./packed-compression.
    const notFoundPackedOptions = { compress: false } as const;
    // Ids whose miss-fill this process originated and has not finished writing. Only originators
    // register (a would-be joiner does not), as in #5488. Unbounded like degradedIdInFlight: every
    // entry is removed when its fetch's lookup and writes settle; a lookup that never settles keeps
    // its ids (as degradedIdInFlight keeps its promise), though past the window they are not counted.
    const missFillInFlight = new Map<number, MissFillEntry>();
    // Holds the FINAL resolved per-id value — post-appendFn, cachedAt stripped — so an L1 hit is
    // byte-identical to what the Redis path returns and needs no further decoration.
    // Driven with get/set rather than its wrapping .fetch — the access pattern here is a batch mGet,
    // not a per-id fetch — so fetchFn is unreachable and throws if it is ever called, and no metrics
    // are passed (this module reports its own L1 hit/miss below).
    const localCache =
      localTtl && localTtl > 0
        ? createLruCache<number, T>({
            name: `${key}:l1`,
            max: localMax,
            maxSize: localMaxBytes,
            ttl: localTtl * 1000,
            keyFn: (id) => String(id),
            fetchFn: () => {
              throw new Error(`createCachedArray L1 fetchFn must not be called [${key}]`);
            },
          })
        : null;

    // Store a SHALLOW CLONE in L1 (and hand out shallow clones on read) so a caller mutating its
    // returned object cannot corrupt the shared L1 instance.
    // 🔴 INVARIANT: shallow only protects TOP-LEVEL fields — nested refs are shared with the L1 copy,
    // so consumers MUST treat returned values as read-only for nested fields. `skip` lets a caller
    // withhold ids the Redis layer itself deliberately did NOT cache (debounce window / dontCacheFn).
    // While Redis is healthy L1 never pins a value Redis chose not to persist, and a writeBack:false
    // fetch writes no L1 at all. The degraded path (Redis read failed) is the exception: it
    // backfills even for writeBack:false, because the L1 is what bounds the DB herd then.
    function backfillLocal(items: T[], skip?: (x: T) => boolean) {
      if (!localCache) return;
      for (const x of items) {
        if (skip?.(x)) continue;
        const id = x[idKey] as unknown as number;
        if (id !== undefined && id !== null) localCache.set(id, { ...x });
      }
    }

    // Drop these ids from THIS pod's L1 on a local bust/refresh/invalidate/update. Does NOT fix
    // cross-pod staleness (inherent + accepted); it closes the self-pod window where the pod that just
    // processed a mutation would otherwise keep serving its own pre-mutation copy for localTtl.
    // Also detaches their in-flight miss-fills, as #5488 does: a fetch after the mutation would
    // originate its own lookup there, not join one that may have read the pre-mutation row.
    function dropLocal(ids: number[]) {
      for (const id of ids) missFillInFlight.delete(id);
      if (!localCache) return;
      for (const id of ids) localCache.delete(id);
    }

    // Counts the ids #5488 would join, and registers the ones it would originate. Call the
    // returned release only after this fetch's writes settle: #5488 keeps an entry joinable through
    // its originator's write.
    function trackMissFill(
      ids: Iterable<number>,
      debounced: Set<number>,
      dontCache: Set<number>
    ): () => void {
      const now = Date.now();
      const registered: [number, MissFillEntry][] = [];
      let joins = 0;
      for (const id of ids) {
        // A debounce-marker id never joins: an in-flight lookup may predate the bust.
        const entry = debounced.has(id) ? undefined : missFillInFlight.get(id);
        if (entry && now - entry.startedAt < MISS_FILL_JOIN_MAX_MS) {
          joins++;
          continue;
        }
        // Not registered inside the debounce window: that lookup is not cached, so #5488 does not
        // let anyone join it.
        if (dontCache.has(id)) continue;
        const mine = { startedAt: now };
        missFillInFlight.set(id, mine);
        registered.push([id, mine]);
      }
      if (joins > 0) {
        // A metrics sink that throws must not fail the read this is only observing.
        try {
          metrics.missWouldJoin(key, joins);
        } catch {}
      }
      return () => {
        // Spares a newer entry for the id (after a detach, or past the join window).
        for (const [id, mine] of registered)
          if (missFillInFlight.get(id) === mine) missFillInFlight.delete(id);
      };
    }

    // Degraded origin (DB) fetch used when a CLUSTER read rejects. Returns the SAME shape as the
    // healthy `fetch` but reads nothing from and writes nothing to Redis. A genuine lookupFn error
    // still propagates (the fetch itself is never wrapped).
    async function fetchFromOriginDegraded(distinctIds: number[]): Promise<T[]> {
      metrics.failOpenDegraded(key);
      // Partition into ids already in flight on this pod (capturing the promise reference NOW so a
      // concurrent settle+delete can't make us miss it) vs. ids we must originate.
      const byId = new Map<number, Promise<T | undefined>>();
      const toFetch: number[] = [];
      for (const id of distinctIds) {
        const existing = degradedIdInFlight.get(`${key}:${id}`) as
          | Promise<T | undefined>
          | undefined;
        if (existing) byId.set(id, existing);
        else toFetch.push(id);
      }

      if (toFetch.length > 0) {
        // Only the ids not already in flight reach lookupFn, so this never double-counts.
        metrics.failOpenOriginFetch(key, toFetch.length);
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
          // Remove the entry once THIS id settles; guard against clobbering a newer same-id round.
          // .catch keeps the cleanup chain from surfacing an unhandledRejection (the rejection is
          // still observed by the Promise.all below).
          void p
            .finally(() => {
              if (degradedIdInFlight.get(mapKey) === p) degradedIdInFlight.delete(mapKey);
            })
            .catch(() => undefined);
        }
      }

      const settled = await Promise.all(
        distinctIds.map((id) => byId.get(id) as Promise<T | undefined>)
      );
      // Clone each record before returning. The per-id single-flight shares ONE object reference
      // across every concurrent caller for that id — but appendFn mutates records IN PLACE and we
      // strip cachedAt below, so without a clone two overlapping degraded fetches corrupt each
      // other's results. Shallow is enough: the appendFns reassign/delete TOP-LEVEL fields.
      const degraded = new Set<T>();
      for (const r of settled) if (r) degraded.add({ ...r } as T);
      if (appendFn) await appendFn(degraded);
      return [...degraded].map((x) => {
        if ('cachedAt' in x) delete (x as AnyRecord).cachedAt;
        return x;
      });
    }

    async function fetch(ids: number[], { writeBack = true }: CachedFetchOptions = {}) {
      if (!ids.length) return [] as T[];
      let distinctIds = [...new Set(ids)];

      // --- L1 (per-pod) read ---------------------------------------------------------------------
      // Serve hot ids from the in-process LRU and drop them from the Redis fan-out, so a full L1 hit
      // returns without a single Redis command.
      const l1Hits: T[] = [];
      if (localCache) {
        const l1Misses: number[] = [];
        for (const id of distinctIds) {
          const hit = localCache.get(id);
          if (hit !== undefined) l1Hits.push({ ...hit });
          else l1Misses.push(id);
        }
        if (l1Hits.length) metrics.hit(key, 'lruCache', l1Hits.length);
        if (l1Misses.length) metrics.miss(key, 'lruCache', l1Misses.length);
        if (l1Misses.length === 0) return l1Hits;
        distinctIds = l1Misses;
      }

      const results = new Set<T>();
      const cacheResults: T[] = [];
      try {
        for (const batch of chunk(distinctIds, 200)) {
          const batchResults = await redis.packed.mGet<T>(
            batch.map((id) => `${key}:${id}` as RedisKeyTemplateCache),
            packedOptions
          );
          cacheResults.push(...batchResults.filter(isDefined));
        }
      } catch (err) {
        // CLUSTER read rejected. Fail OPEN to a per-id single-flighted origin fetch rather than
        // propagating a 500 on these hot paths. lookupFn is OUTSIDE this catch (inside
        // fetchFromOriginDegraded), so a genuine DB/logic error still propagates.
        logFailOpen('read-degraded', `createCachedArray mGet (cache cluster) [${key}]`, err, {
          key,
          ids: distinctIds.length,
        });
        const degraded = await fetchFromOriginDegraded(distinctIds);
        // Backfill L1 even during a wedge (short TTL; helps bound the DB herd) and merge any ids
        // already served from L1 before the read failed. Honor dontCacheFn (dontCache is a Redis-hit
        // concept, not reachable on this path).
        backfillLocal(degraded, dontCacheFn ? (x) => !!dontCacheFn(x) : undefined);
        return localCache ? [...l1Hits, ...degraded] : degraded;
      }
      const cacheArray = cacheResults.filter((x) => x !== null) as T[];
      const cache = Object.fromEntries(cacheArray.map((x) => [x[idKey], x])) as Record<string, any>;

      const cacheDebounceCutoff = new Date(Date.now() - debounceTime * 1000);
      const cacheMisses = new Set<number>();
      const dontCache = new Set<number>();
      const debounced = new Set<number>();
      const toRevalidate: Record<number, T> = {};
      const ttlExpiry = new Date(Date.now() - ttl * 1000);
      const locks = new Set<RedisKeyTemplateCache>();
      let cacheHits = 0;
      for (const id of distinctIds) {
        const cached = cache[id];
        if (cached) {
          if (cached.notFound) continue;
          if (cached.debounce) {
            debounced.add(id);
            if (cached.cachedAt > cacheDebounceCutoff) dontCache.add(id);
            cacheMisses.add(id);
            continue;
          }
          // A read-only fetch could not write a revalidated value back, so a stale entry is
          // served as a hit.
          if (writeBack && staleWhileRevalidate && cached.cachedAt < ttlExpiry) {
            toRevalidate[id] = cached;
            continue;
          }
          results.add(cached);
          cacheHits++;
        } else cacheMisses.add(id);
      }

      if (cacheHits > 0) metrics.hit(key, 'cachedArray', cacheHits);

      const toRevalidateIds = Object.keys(toRevalidate).map(Number);
      if (toRevalidateIds.length > 0) {
        metrics.revalidate(key, 'cachedArray', toRevalidateIds.length);

        let gotLocks: boolean[];
        try {
          gotLocks = await Promise.all(
            toRevalidateIds.map((id) =>
              redis.setNxKeepTtlWithEx(
                `${REDIS_KEYS.CACHE_LOCKS}:${key}:${id}` as RedisKeyTemplateCache,
                '1',
                10
              )
            )
          );
        } catch (err) {
          // The revalidate lock is a CLUSTER WRITE; on error we already hold a fresh-enough stale
          // value for every toRevalidate id, so serve it rather than 500. Treating every lock as
          // not-acquired skips revalidation this pass — cheap and correct.
          logFailOpen(
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
          locks.add(`${REDIS_KEYS.CACHE_LOCKS}:${key}:${id}` as RedisKeyTemplateCache);
        }
      }

      if (dontCache.size > 0)
        log(`${key}: Cache debounce - ${dontCache.size} items: ${[...dontCache].join(', ')}`);

      if (cacheMisses.size > 0) {
        log(`${key}: Cache miss - ${cacheMisses.size} items: ${[...cacheMisses].join(', ')}`);

        // finally: a throwing lookupFn must not leave its ids registered as in flight.
        // A read-only lookup is never cached, so like a debounce-window lookup it registers nothing.
        const releaseMissFill = trackMissFill(
          cacheMisses,
          debounced,
          writeBack ? dontCache : cacheMisses
        );
        try {
          const dbResults: Record<string, T> = {};
          const lookupBatches = chunk([...cacheMisses], 10000);
          for (const batch of lookupBatches) {
            const batchResults = await lookupFn([...batch] as typeof ids);
            Object.assign(dbResults, batchResults);
          }

          const toCache: Record<string, AnyRecord> = {};
          const toCacheNotFound: Record<string, AnyRecord> = {};
          const cachedAt = new Date();
          let actualMisses = 0;
          for (const id of cacheMisses) {
            const result = dbResults[id];
            if (!result) {
              if (cacheNotFound) {
                if (writeBack) toCacheNotFound[id] = { [idKey]: id, notFound: true, cachedAt };
                actualMisses++;
              }
              // When cacheNotFound=false, don't count as a miss since we don't cache it.
              continue;
            }
            results.add(result as T);
            actualMisses++;
            if (writeBack && !dontCache.has(id) && !dontCacheFn?.(result))
              toCache[id] = { ...result, cachedAt };
          }

          if (actualMisses > 0) metrics.miss(key, 'cachedArray', actualMisses);

          // The DB lookup already SUCCEEDED — a CLUSTER WRITE failure here must NOT turn a good origin
          // fetch into a 500. Swallow best-effort (the entry just isn't cached this pass).
          const EX = resolveCacheExpiry(ttl, staleWhileRevalidate, staleWhileRevalidateTtl);
          try {
            if (Object.keys(toCache).length > 0)
              await Promise.all(
                Object.entries(toCache).map(([id, value]) =>
                  redis.packed.set(
                    `${key}:${id}` as RedisKeyTemplateCache,
                    value,
                    { EX },
                    packedOptions
                  )
                )
              );

            // NX so a real value is never overwritten by a notFound. notFoundTtl caps negative-cache
            // lifetime separately, for lookups whose empty result is likely transient.
            if (Object.keys(toCacheNotFound).length > 0) {
              const notFoundEX = notFoundTtl ?? EX;
              await Promise.all(
                Object.entries(toCacheNotFound).map(([id, value]) =>
                  redis.packed.set(
                    `${key}:${id}` as RedisKeyTemplateCache,
                    value,
                    { EX: notFoundEX, NX: true },
                    notFoundPackedOptions
                  )
                )
              );
            }
          } catch (err) {
            logFailOpen('write-degraded', `createCachedArray set (cache cluster) [${key}]`, err, {
              key,
            });
          }
        } finally {
          releaseMissFill();
        }
      }

      // Best-effort: a failed del just leaves the lock to expire via its 10s TTL — never let it mask
      // the successful fetch result.
      if (locks.size > 0)
        await redis
          .del([...locks])
          .catch((err) =>
            logFailOpen(
              'write-degraded',
              `createCachedArray del-locks (cache cluster) [${key}]`,
              err,
              { key }
            )
          );

      if (appendFn) await appendFn(results);

      const final = [...results].map((x) => {
        // cachedAt is internal.
        if ('cachedAt' in x) delete (x as AnyRecord).cachedAt;
        return x;
      });

      // Backfill L1 with the FINAL shape (post-appendFn, cachedAt stripped) so a later L1 hit is
      // byte-identical to this return. Skip exactly what the Redis write skipped.
      if (writeBack)
        backfillLocal(
          final,
          (x) => dontCache.has(x[idKey] as unknown as number) || !!dontCacheFn?.(x)
        );
      return localCache ? [...l1Hits, ...final] : final;
    }

    async function bust(id: number | number[], options: { debounceTime?: number } = {}) {
      const ids = Array.isArray(id) ? id : [id];
      if (ids.length === 0) return;
      dropLocal(ids);

      await Promise.all(
        ids.map((id) =>
          redis.packed.set(
            `${key}:${id}` as RedisKeyTemplateCache,
            { [idKey]: id, debounce: true },
            { EX: options.debounceTime ?? debounceTime },
            packedOptions
          )
        )
      );
      log(`Busted ${ids.length} ${key} items: ${ids.join(', ')}`);
    }

    async function invalidate(id: number | number[], options: { debounceTime?: number } = {}) {
      const ids = Array.isArray(id) ? id : [id];
      if (ids.length === 0) return;
      dropLocal(ids);

      const cacheResults: T[] = [];
      for (const batch of chunk(ids, 200)) {
        const batchResults = await redis.packed.mGet<T>(
          batch.map((id) => `${key}:${id}` as RedisKeyTemplateCache),
          packedOptions
        );
        cacheResults.push(...batchResults.filter(isDefined));
      }

      const invaliDate = new Date(
        Date.now() - ttl * 1000 + (options.debounceTime ?? debounceTime) * 1000
      );
      const updates = cacheResults.filter(
        (x) => x !== null && 'cachedAt' in x && (x as AnyRecord).cachedAt !== invaliDate
      ) as T[];
      if (updates.length === 0) return;
      const toCache = Object.fromEntries(
        updates.map((x) => [x[idKey], { ...x, cachedAt: invaliDate }])
      );
      // invalidate is only wired up when staleWhileRevalidate is true (see the returned `bust`), so
      // resolve the tail with SWR=true to honor any trim.
      const EX = resolveCacheExpiry(ttl, true, staleWhileRevalidateTtl);
      if (Object.keys(toCache).length > 0)
        await Promise.all(
          Object.entries(toCache).map(([id, value]) =>
            redis.packed.set(`${key}:${id}` as RedisKeyTemplateCache, value, { EX }, packedOptions)
          )
        );

      log(`Invalidated ${ids.length} ${key} items: ${ids.join(', ')}`);
    }

    async function refresh(id: number | number[]) {
      const ids = Array.isArray(id) ? id : [id];
      dropLocal(ids);

      try {
        const results = await lookupFn(ids, true);
        // appendFn is a read-side decorator that may mutate records in place. refresh() is
        // fire-and-forget, so running it here only risks persisting post-mutation shape to Redis.
        const cachedAt = new Date();
        const EX = resolveCacheExpiry(ttl, staleWhileRevalidate, staleWhileRevalidateTtl);
        // Honor dontCacheFn exactly as fetch() and the degraded path do — a cache using it as a
        // correctness guard otherwise loses that guard entirely, since refresh() is what every
        // bust-and-repopulate helper calls. `x &&` keeps a falsy value classified as "no row".
        const cacheable = Object.entries(results).filter(([, x]) => x && !dontCacheFn?.(x));
        await Promise.all(
          cacheable.map(([rid, x]) =>
            redis.packed.set(
              `${key}:${rid}` as RedisKeyTemplateCache,
              { ...x, cachedAt },
              { EX },
              packedOptions
            )
          )
        );

        // An id with no row and an id we're not allowed to hold both have to end up ABSENT rather
        // than merely un-refreshed — leaving the prior entry keeps serving the very value this
        // refresh was called to replace.
        const cached = new Set(cacheable.map(([rid]) => rid));
        const toRemove = ids.map(String).filter((rid) => !cached.has(rid));
        await Promise.all(
          toRemove.map((rid) => redis.del(`${key}:${rid}` as RedisKeyTemplateCache))
        );
      } catch (error) {
        // Refresh is best-effort: swallow and fall back to bust semantics so the next reader
        // re-fetches from primary. A committed mutation must not 500 because the refill failed.
        logRefreshError({
          cacheKey: key,
          ids: ids.join(','),
          error: error instanceof Error ? error.message : String(error),
        });
        const fallbackBust = staleWhileRevalidate ? invalidate : bust;
        await fallbackBust(ids).catch(() => undefined);
      }
    }

    /**
     * Write-through: rewrite ONE cached entry from the delta the caller already
     * knows, instead of re-deriving it from the origin. For a cache whose entry is a
     * large per-user collection, `refresh` costs a full unbounded primary query per
     * mutation; this costs a GET and a SET.
     *
     * Returns whether the entry was rewritten. FALSE means there was nothing here to
     * correct — absent, a debounce or notFound marker, past its expiry, or another
     * writer holds the entry — and the caller decides what that means. A caller that
     * needs the entry to be right afterwards must fall back to `refresh`, since a
     * missing entry would otherwise be repopulated by the next reader from the
     * REPLICA, which is the one thing a just-written value cannot tolerate.
     *
     * `cachedAt` is carried over rather than reset, and the write re-derives the
     * REMAINDER of the original expiry: an entry maintained by deltas must still age
     * out on its own schedule, or a drifted one never self-heals.
     *
     * 🔴 NOT `KEEPTTL`, which is the obvious way to write that and is wrong here.
     * `SET key value KEEPTTL` on a key that has GONE — expired or evicted in the few
     * ms since the GET — creates it with NO TTL at all: KEEPTTL preserves an existing
     * expiry, it does not invent one. For a cache whose readers do not consult
     * `cachedAt`, that entry is then served forever with no self-heal, which is the
     * exact property this comment claims to protect. `XX` closes the same hole from
     * the other side and is kept as well: Redis refuses to create the key, the reply
     * is null, and this reports false so the caller re-derives.
     *
     * ⚠️ ONE caller today — `userFollowsCache`, which is non-SWR. Two things a second
     * caller has to weigh. A plain cache-MISS refill takes no lock, so this serialises
     * `update` against `update` only; a refill that started before a delta can still
     * land on top of it. And the DB write happens outside the lock, so two mutations
     * of the same entry can reach Redis in the opposite order to their commits and
     * leave the entry WRONG rather than stale — where `refresh` re-read the origin and
     * therefore converged. Both are bounded by the entry's TTL, neither self-heals
     * sooner.
     */
    async function update(id: number, updater: (current: T) => T): Promise<boolean> {
      const entryKey = `${key}:${id}` as RedisKeyTemplateCache;
      // Two concurrent read-modify-writes on one entry lose one of the deltas, and a
      // lost delta persists for the rest of the TTL. The loser reports false and
      // takes the caller's fallback, which re-derives from the origin.
      const lockKey = `${REDIS_KEYS.CACHE_LOCKS}:${key}:${id}:update` as RedisKeyTemplateCache;

      try {
        if (!(await redis.setNxKeepTtlWithEx(lockKey, '1', UPDATE_LOCK_TTL))) return false;
      } catch (err) {
        logFailOpen('write-degraded', `createCachedArray update lock [${key}]`, err, { key, id });
        return false;
      }

      try {
        const [current] = await redis.packed.mGet<T>([entryKey], packedOptions);
        const marker = current as AnyRecord | null;
        if (!current || marker?.notFound || marker?.debounce || !marker?.cachedAt) return false;

        // The remainder of the original expiry. ⚠️ This assumes the entry was written
        // with a full expiry AT `cachedAt`, which `invalidate` deliberately breaks by
        // backdating it — so on a cache that reaches `invalidate` (SWR only; no caller
        // does today) this shortens a live entry rather than lengthening it. That is
        // the safe direction to be wrong in, which KEEPTTL is not.
        const EX =
          resolveCacheExpiry(ttl, staleWhileRevalidate, staleWhileRevalidateTtl) -
          Math.floor((Date.now() - new Date(marker.cachedAt).getTime()) / 1000);
        if (EX <= 0) return false;

        const next = updater(current);
        if (dontCacheFn?.(next)) return false;
        // XX: correct an entry, never create one. If it vanished between the GET and
        // here, the reply is null and the caller must re-derive rather than have a
        // whole collection materialised from one delta.
        const written = await redis.packed.set(
          entryKey,
          { ...next, cachedAt: marker.cachedAt },
          { EX, XX: true },
          packedOptions
        );
        if (written === null) return false;
        // After the write, not before: a concurrent fetch between the two would
        // otherwise refill L1 with the pre-update value and pin it for localTtl.
        dropLocal([id]);
        return true;
      } catch (err) {
        logFailOpen('write-degraded', `createCachedArray update [${key}]`, err, { key, id });
        return false;
      } finally {
        await redis.del(lockKey).catch(() => undefined);
      }
    }

    async function flush() {
      localCache?.clear();
      await clearByPattern(`${key}:*`);
    }

    return { fetch, bust: staleWhileRevalidate ? invalidate : bust, refresh, update, flush };
  }

  function createCachedObject<T extends object>(lookupOptions: CachedLookupOptions<T>) {
    const cachedArray = createCachedArray<T>(lookupOptions);

    async function fetch(ids: number | number[], options?: CachedFetchOptions) {
      if (!Array.isArray(ids)) ids = [ids];
      const results = await cachedArray.fetch(ids, options);
      return Object.fromEntries(
        results.map((x) => [(x[lookupOptions.idKey] as number | string).toString(), x])
      ) as Record<string, T>;
    }

    return { ...cachedArray, fetch };
  }

  return { createCachedArray, createCachedObject };
}

export type CacheBuilders = ReturnType<typeof createCacheBuilders>;

// Declared structurally rather than as ReturnType<…createCachedArray> — that instantiates the generic
// at its `object` constraint, so every consumer's element type collapses to `object`.
export type CachedArray<T extends object> = {
  fetch(ids: number[], options?: CachedFetchOptions): Promise<T[]>;
  bust(id: number | number[], options?: { debounceTime?: number }): Promise<void>;
  refresh(id: number | number[]): Promise<void>;
  update(id: number, updater: (current: T) => T): Promise<boolean>;
  flush(): Promise<void>;
};
export type CachedObject<T extends object> = Omit<CachedArray<T>, 'fetch'> & {
  fetch(ids: number | number[], options?: CachedFetchOptions): Promise<Record<string, T>>;
};
