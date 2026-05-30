/**
 * In-memory cache + in-flight coalescing for the cold-mint path of
 * `getOrchestratorToken`. Sits in front of `getTemporaryUserApiKey` only —
 * the sysRedis hot path remains the source of truth when healthy and is
 * not cached here.
 *
 * When does the cache fire?
 * -------------------------
 * Any time `getOrchestratorToken`'s `if (!token)` branch executes — i.e.
 * any `getTemporaryUserApiKey` invocation. That includes:
 *   (a) sysRedis hGet failed (the original outage-amplification case),
 *   (b) first-ever auth for a user (the sysRedis hash field doesn't exist
 *       yet),
 *   (c) hourly TTL rotation when the cached hash field has expired.
 *
 * (Cookie-mode flow exists in the source but is currently dead code:
 * `TOKEN_STORE` at get-orchestrator-token.ts is statically `'redis'`
 * because of an unconditional ternary, so the cookie else-branch is
 * unreachable at runtime. If that gets flipped, the cookie-absent path
 * also funnels through this cache.)
 *
 * So the cache runs on healthy steady-state traffic, NOT only during
 * outage windows. The primary motivation below remains amplification
 * protection during a sysRedis outage (that's the worst-case load), but
 * day-to-day this is also a per-pod dampener on first-auth and on every
 * hourly rotation.
 *
 * Motivation
 * ----------
 * If sysRedis is unavailable (and during the 15–25s failover window of the
 * HA migration, briefly it will be), every authenticated request that
 * needs an orchestrator token falls through to
 * `getTemporaryUserApiKey(userId)`. That function runs **1 INSERT + 2
 * deleteMany** per call. At civitai-dp-prod scale (80 pods × ~1k RPS) a
 * sustained sysRedis-down event would aim ~80k inserts/s and ~160k
 * deletes/s at the primary — the "cold-mint amplification" failure mode
 * tracked by the `sysredis-token-mint-amplification-warn` alert (see
 * `logSysRedisFailOpen('token-mint-amplification', ...)` in
 * `get-orchestrator-token.ts`).
 *
 * Two layers, both per-pod, both in-memory (deliberately not Redis — the
 * whole point is to survive sysRedis being unavailable):
 *
 *   1. LRU cache (size-capped + TTL): cache `userId → token` for ~60s.
 *      Cold-mint hits the DB at most once per user per 60s per pod.
 *
 *   2. In-flight promise coalescing: when N concurrent requests for the
 *      same userId would all cold-mint at the same time, share one
 *      promise. This is the actual thundering-herd protection during
 *      failover; the LRU alone leaves a wide race window on first miss.
 *
 * Tradeoffs / safety notes
 * ------------------------
 *  - TTL is bounded well under the underlying API-key DB-side expiresAt
 *    (`generationServiceCookie.maxAge + 5`, ~1h). The cached token cannot
 *    outlive the row it represents.
 *  - Cache is per-pod. A token minted on pod A is NOT visible on pod B.
 *    That is correct — sysRedis is the cross-pod cache; this layer is
 *    only an amplification dampener while sysRedis is degraded. Per-pod
 *    isolation also caps blast radius (a poisoned cache entry can only
 *    affect one pod's traffic).
 *  - No cache invalidation API. Eviction is implicit-via-TTL. If a token
 *    is revoked mid-cache-window the worst case is one stale token until
 *    the entry expires; the orchestrator will reject it and the next
 *    request mints fresh.
 *  - Bounded memory: `max` entries × ~40 bytes/token ≈ 2 MB worst case.
 */

import { LRUCache } from 'lru-cache';
import { cacheHitCounter, cacheMissCounter } from '~/server/prom/client';

const CACHE_NAME = 'orchestrator-token-cold-mint';
const CACHE_TYPE = 'lruCache';

// 50k entries × ~60s TTL. With 80 pods, an active-user set in the low
// thousands will round-trip each user to the DB roughly once per minute
// per pod during sysRedis-down — a 60-100x reduction in DB load vs the
// uncached fallback. Both knobs can be tuned via env without code change.
const DEFAULT_MAX = 50_000;
const DEFAULT_TTL_MS = 60_000;

// Read a non-negative integer env var. Returns `fallback` only when the
// env var is unset / non-numeric / negative. `0` is a valid explicit
// value — for `ORCHESTRATOR_TOKEN_CACHE_MAX` it is the kill-switch
// (CACHE_DISABLED below) and `LRUCache` requires `max >= 1` so the
// constructor is also skipped when disabled.
function readNonNegativeInt(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

const MAX_ENTRIES = readNonNegativeInt('ORCHESTRATOR_TOKEN_CACHE_MAX', DEFAULT_MAX);
const TTL_MS = readNonNegativeInt('ORCHESTRATOR_TOKEN_CACHE_TTL_MS', DEFAULT_TTL_MS);

// Kill-switch. Computed once at module load so the hot path is a single
// boolean check, not a per-call env read. To disable the cache in
// production, set `ORCHESTRATOR_TOKEN_CACHE_MAX=0` and roll the pods.
// `getOrMintCachedToken` then becomes a straight passthrough to `mint()`
// (no caching, no coalescing) — useful as a no-redeploy kill-switch if
// the cache itself is implicated in an incident.
const CACHE_DISABLED = MAX_ENTRIES === 0;

// Skip constructing the LRU at all when disabled — lru-cache rejects
// `max: 0` at construction time, and there's no point allocating the
// backing arrays we'll never touch.
const tokenCache = CACHE_DISABLED
  ? null
  : new LRUCache<number, string>({
      max: MAX_ENTRIES,
      ttl: TTL_MS,
      // Without this, expired entries linger in the LRU's internal arrays
      // until they're touched or evicted by capacity pressure. That makes
      // `cache.size` look pinned at `max` long after the active set has
      // shrunk, which frustrates leak diagnostics from prom / heap dumps.
      ttlAutopurge: true,
    });

const inflight = new Map<number, Promise<string>>();

/**
 * Run `mint()` for `userId` with cache + coalescing.
 *
 * Caller contract: `mint` must be idempotent (we may share its result
 * across all current callers for this userId). `getTemporaryUserApiKey`
 * is — every call mints a fresh DB-backed key and trims older ones.
 */
export async function getOrMintCachedToken(
  userId: number,
  mint: () => Promise<string>
): Promise<string> {
  // Kill-switch: when `ORCHESTRATOR_TOKEN_CACHE_MAX=0`, bypass both the
  // cache AND the coalescing layer. N concurrent callers all hit `mint()`
  // directly — same behaviour as before this module existed. No counters
  // fire (cache is conceptually absent).
  if (CACHE_DISABLED || !tokenCache) {
    return mint();
  }

  const cached = tokenCache.get(userId);
  if (cached !== undefined) {
    cacheHitCounter.inc({ cache_name: CACHE_NAME, cache_type: CACHE_TYPE });
    return cached;
  }

  const pending = inflight.get(userId);
  if (pending) {
    // Coalesce: another request for this user is already minting. Share
    // its promise. Still counts as a miss — the DB call is happening,
    // we're just not duplicating it.
    cacheMissCounter.inc({ cache_name: CACHE_NAME, cache_type: CACHE_TYPE });
    return pending;
  }

  cacheMissCounter.inc({ cache_name: CACHE_NAME, cache_type: CACHE_TYPE });

  const promise = (async () => {
    try {
      const token = await mint();
      tokenCache.set(userId, token);
      return token;
    } finally {
      // Always clear the in-flight slot, even on rejection — otherwise a
      // single transient mint failure would wedge all future requests
      // for this user behind a rejected promise.
      inflight.delete(userId);
    }
  })();

  inflight.set(userId, promise);
  return promise;
}

// Test-only escape hatches. Kept on the module export so tests can clear
// state between cases without poking module internals.
export const __testing = {
  clear() {
    tokenCache?.clear();
    inflight.clear();
  },
  size() {
    return { cache: tokenCache?.size ?? 0, inflight: inflight.size };
  },
  isDisabled() {
    return CACHE_DISABLED;
  },
};
