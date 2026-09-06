import type { Prisma, PrismaClient } from '@prisma/client';
import { chunk } from 'lodash-es';
// `prefixCacheKey` comes from the package rather than the `~/server/redis/client` shim on
// purpose: it is a pure helper with no client state, and importing it through the shim would
// force every suite that mocks the shim to add it to its mock factory.
import { CACHE_KEY_PREFIX, createCacheBuilders, prefixCacheKey } from '@civitai/redis';
import { CacheTTL } from '~/server/common/constants';
import { logToAxiom } from '~/server/logging/client';
import {
  cacheFailOpenDegradedCounter,
  cacheFailOpenOriginFetchCounter,
  cacheHitCounter,
  cacheMissCounter,
  cacheRevalidateCounter,
} from '~/server/prom/client';
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

/**
 * The prefix every key of `target`'s keyspace carries on this deployment — `''` in production.
 *
 * 🔴 THE ASYMMETRY IS DELIBERATE — AND IT IS NOT A SAFETY CLAIM. `'sys'` is ALWAYS `''`, even on
 * a namespaced deployment. Environment namespacing is CACHE-ONLY (see
 * packages/civitai-redis/src/cache-key-prefix.ts): `REDIS_SYS_KEYS` is never run through
 * `applyCacheKeyPrefix`, so system keys are unprefixed on EVERY deployment. Prefixing a sys
 * pattern would therefore match nothing at all. Do not "fix" this into consistency, and do not
 * gate it on a namespace being set — the keys are unprefixed either way.
 *
 * 🔴 WHAT THIS DOES NOT MEAN. A deployment's system-Redis instance is NOT guaranteed to be
 * distinct from production's; some non-production deployments share it. So `target: 'sys'` is
 * exempt because its keys CANNOT be namespaced, not because the keyspace is isolated. A
 * `target: 'sys'` clear issued from a non-production deployment can reach PRODUCTION data, and
 * nothing in this file stands in its way.
 *
 * That makes sys the more dangerous of the two targets, not the safer one: cache entries are
 * regenerable from the database, system values are not — a deleted one is simply gone. Treat any
 * `target: 'sys'` clear as a production operation regardless of where it is run from.
 */
function cacheNamespacePrefix(target: CacheTarget): string {
  return target === 'sys' ? '' : CACHE_KEY_PREFIX;
}

/**
 * Scope a caller-supplied cache-key GLOB (or exact key) to this deployment's cache namespace.
 *
 * 🔴 WHY THIS EXISTS. The admin cache-clear endpoint takes a glob from its caller and hands it to
 * `clearCacheByPattern*`, which SCAN the shared cache instance with it. That glob is written by
 * hand against the PRODUCTION key shape (`packed:caches:*`). Run from a namespaced deployment,
 * an unscoped glob matches production's keys and NOTHING of the caller's own (whose keys live at
 * `<namespace>:packed:caches:*`) — i.e. the one environment it can clear is the one it must never
 * touch. Scoping the glob inverts that: it can only ever address its own namespace.
 *
 * Identity in production (empty prefix). Also identity for `target: 'sys'`, which is a mechanical
 * consequence of system keys never being namespaced — NOT a containment guarantee for that
 * target. See `cacheNamespacePrefix`.
 *
 * 🔴 Call this ONLY on a pattern that was built from scratch by a caller. A pattern derived from
 * `REDIS_KEYS` already carries the prefix from the key table itself, and scoping it again yields
 * `<namespace>:<namespace>:…` — the same rule that governs `prefixCacheKey`.
 */
export function scopeCachePatternToNamespace(pattern: string, target: CacheTarget = 'main') {
  const prefix = cacheNamespacePrefix(target);
  return prefix ? `${prefix}${pattern}` : pattern;
}

/**
 * Containment invariant for the clear helpers: on a namespaced deployment EVERY key of the main
 * cache carries the namespace prefix — the key table is prefixed wholesale by
 * `applyCacheKeyPrefix`, and on-the-fly keys go through `prefixCacheKey`. So a key without the
 * prefix belongs to another environment (production, in the damaging case) and must never be
 * deleted from here, whatever pattern reached this function.
 *
 * Always true in production and for `target: 'sys'`, where the prefix is empty — so this provides
 * NO containment on the sys target, which cannot be namespaced at all. See `cacheNamespacePrefix`.
 */
function isInCacheNamespace(key: string, target: CacheTarget) {
  const prefix = cacheNamespacePrefix(target);
  return !prefix || key.startsWith(prefix);
}

type cachedQueryOptions = {
  ttl: number;
  tag: string | string[];
};
export function queryCache(db: PrismaClient, key: string, version?: string) {
  return async function <T extends object[]>(query: Prisma.Sql, options?: cachedQueryOptions) {
    if (options?.ttl === 0) return db.$queryRaw<T>(query);

    // this typing is not quite right, as we're creating redis keys on the fly here.
    // These keys are minted from a free-form `key` rather than derived from REDIS_KEYS, so they
    // don't inherit the environment prefix from the key table — apply it explicitly. Without
    // this, previews would share these entries with production. No-op in production.
    const cacheKey = prefixCacheKey(
      [key, version, hashifyObject(query).toString()].filter(isDefined).join(':')
    ) as RedisKeyTemplateCache;
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

    // this typing is not quite right, as we're creating redis keys on the fly here.
    // Same on-the-fly minting as queryCache above — apply the environment prefix explicitly.
    const cacheKey = prefixCacheKey(
      [key, version, hashifyObject(query).toString()].filter(isDefined).join(':')
    ) as RedisKeyTemplateCache;
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

// The batched per-id cache builders live in @civitai/redis so the monorepo's other apps can use
// them. Bound here to this app's client, prom counters, loggers and LRU factory, and re-exported from
// the original path so existing imports (and the suites that mock this module) are unaffected.
const { createCachedArray, createCachedObject } = createCacheBuilders({
  redis,
  defaultTtl: CacheTTL.xs,
  metrics: {
    hit: (cache_name, cache_type, count) => cacheHitCounter.inc({ cache_name, cache_type }, count),
    miss: (cache_name, cache_type, count) =>
      cacheMissCounter.inc({ cache_name, cache_type }, count),
    revalidate: (cache_name, cache_type, count) =>
      cacheRevalidateCounter.inc({ cache_name, cache_type }, count),
    failOpenDegraded: (cache_name) => cacheFailOpenDegradedCounter.inc({ cache_name }),
    failOpenOriginFetch: (cache_name, count) =>
      cacheFailOpenOriginFetchCounter.inc({ cache_name }, count),
  },
  logFailOpen: (kind, message, error, meta) => logSysRedisFailOpen(kind, message, error, meta),
  logRefreshError: ({ cacheKey, ids, error }) =>
    void logToAxiom(
      { type: 'error', name: 'cache-refresh-failed', cacheKey, ids, error },
      'civitai-prod'
    ).catch(() => undefined),
  log,
  clearByPattern: (pattern) => clearCacheByPattern(pattern),
});

export { createCachedArray, createCachedObject };
export { resolveCacheExpiry } from '@civitai/redis';
export type { CachedArray, CachedObject } from '@civitai/redis';

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
  // Opt-in brotli compression of the packed value at rest. Only enable for LARGE,
  // highly-compressible blobs (e.g. tensor-metadata's ~335 KB tensor-name strings) —
  // most cached values are tiny and would only pay the codec overhead. Reads decode
  // both compressed and legacy-uncompressed entries transparently (sentinel-tagged),
  // so flipping this on/off is back-compat safe with existing keys. Safe here because
  // fetchThroughCache always stores the `{ data, cachedAt }` wrapper object (never a
  // bare scalar) — see the SENTINEL SAFETY note in redis/client.ts.
  compress?: boolean;
  // Metrics-only: the `cache_name` label put on the codec duration histogram for this key's
  // compress/decompress calls. Pass the cache PREFIX, never the full per-id key — `key` here is
  // routinely `${prefix}:${id}`, so using it directly would be unbounded label cardinality.
  // Ignored entirely unless `compress` is on (nothing else records codec time).
  cacheName?: string;
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
  const p = Promise.resolve()
    .then(fetchFn)
    .finally(() => {
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
  const compress = options.compress ?? false;
  const cacheName = options.cacheName;
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
    // Thread `compress` to the READ so it's symmetric with the compressed write below:
    // only a compressed caller's get attempts brotli-decompress, and only that path
    // carries the sentinel invariant. Non-compress callers read via the general path.
    cachedData = await redis.packed.get<FetchThroughCacheEntity<T>>(key, { compress, cacheName });
  } catch (err) {
    logSysRedisFailOpen('read-degraded', 'fetchThroughCache get (cache cluster)', err, { key });
    return fetchThroughCacheFailOpen(key, fetchFn);
  }

  // A malformed entry (no `data`, or a non-numeric `cachedAt`) is treated as a MISS
  // rather than served. Two reasons: the signature promises `T`, so returning
  // `cachedData.data` hands callers an `undefined` the type system said was
  // impossible — that shape crashed `model.getResourceSelect` on 2026-07-28. And a
  // missing `cachedAt` makes the staleness compare `NaN > n` → false, so the bad
  // entry would never expire into a refresh. Nulling it here routes both cases
  // through the origin fetch below, which overwrites the entry and self-heals.
  // Only `undefined` counts as missing — `null` is a legitimate cached value.
  if (cachedData && (cachedData.data === undefined || typeof cachedData.cachedAt !== 'number')) {
    cachedData = null;
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
        compress,
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
      await redis.packed.set(key, toCache, { EX: ttl * 2 }, { compress, cacheName });
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

export async function bustFetchThroughCache(
  key: RedisKeyTemplateCache,
  // `compress` MUST match the setting the corresponding fetchThroughCache() uses for
  // this key. If a key is stored compressed (sentinel-tagged brotli) but busted with
  // compress=false, the read decodes via the general msgpack path → throws → the entry
  // is EVICTED and `!cachedData` silently no-ops the bust (the staleness reset never
  // happens). Threaded as an explicit opt-in (symmetric with fetchThroughCache) so
  // busting a compressed cache is correct rather than a latent landmine. No current
  // caller compresses a busted key; this guards future ones.
  options: { compress?: boolean } = {}
) {
  const compress = options.compress ?? false;
  const cachedData = await redis.packed.get<FetchThroughCacheEntity<any>>(key, { compress });
  if (!cachedData) return;

  const toCache: FetchThroughCacheEntity<any> = { data: cachedData.data, cachedAt: 0 };
  await redis.packed.set(key, toCache, { KEEPTTL: true }, { compress });
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
    // Namespace containment (see `isInCacheNamespace`). No scan happens on this path, so this is
    // the only thing standing between an out-of-namespace exact key and a `del` of another
    // environment's entry. No-op in production and for `target: 'sys'`.
    if (!isInCacheNamespace(pattern, target)) {
      log('Skipping out-of-namespace key:', pattern, 'target:', target);
      return cleared;
    }
    await client.del(pattern);
    cleared.push(pattern);
    onProgress?.(cleared.length);
    return cleared;
  }

  // Use cluster's scanIterator which handles scanning all nodes
  log('Scanning cache with pattern:', pattern, 'target:', target);
  const stream = client.scanIterator({ MATCH: pattern, COUNT: 10000 });

  for await (const keys of stream) {
    // Namespace containment. A scoped pattern already confines the SCAN server-side; this filter
    // is what makes the confinement structural rather than a property of the call site, so a
    // caller that forgets to scope its glob clears NOTHING instead of another environment's keys.
    const newKeys = (keys as RedisKeyTemplates[]).filter(
      (key) => isInCacheNamespace(key, target) && !cleared.includes(key)
    );
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
    // Namespace containment (see `isInCacheNamespace`) — same reasoning as the exact-key path of
    // `clearCacheByPattern`: nothing else guards a bare `del` here.
    if (!isInCacheNamespace(p.pattern, target)) {
      log('Skipping out-of-namespace key:', p.pattern, 'target:', target);
      continue;
    }
    await client.del(p.pattern as RedisKeyTemplates);
    p.cleared.push(p.pattern);
  }

  if (globbed.length > 0) {
    log('Scanning cache for', globbed.length, 'patterns in a single pass, target:', target);
    // 🔴 This path enumerates the keyspace itself and regex-tests each key, so scoping the
    // caller's patterns is NOT enough on its own — with `MATCH: '*'` it would walk every other
    // environment's keys (production's included) and rely entirely on the regexes to spare them.
    // Confining the SCAN to the namespace makes that structural: on a namespaced deployment a
    // foreign key is never even enumerated, so no pattern — scoped, unscoped or malformed — can
    // reach one. `'*'` in production and for `target: 'sys'`, i.e. byte-identical to before.
    const scanPrefix = cacheNamespacePrefix(target);
    const stream = client.scanIterator({ MATCH: `${scanPrefix}*`, COUNT: 10000 });

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
