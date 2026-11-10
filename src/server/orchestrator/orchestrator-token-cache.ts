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
 * deleteMany** per call. Across the fleet, a sustained sysRedis-down event
 * would aim that INSERT + delete load at the primary for every request —
 * the "cold-mint amplification" failure mode (see
 * `logSysRedisFailOpen('token-mint-amplification', ...)` in
 * `get-orchestrator-token.ts`).
 *
 * Two layers, both per-pod, both in-memory (deliberately not Redis — the
 * whole point is to survive sysRedis being unavailable):
 *
 *   1. LRU cache (size-capped + TTL): cache `userId → <userId>.<token>` for ~60s.
 *      The value repeats the id so a hit can be verified rather than trusted —
 *      see orchestrator-token-identity.ts.
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
 *  - No cache invalidation API. Eviction is implicit-via-TTL.
 *  - Bounded memory: `max` entries × ~50 bytes/entry ≈ 2.5 MB worst case.
 *
 * Revocation
 * ----------
 * Entries are never invalidated; they age out after `ORCHESTRATOR_TOKEN_CACHE_TTL_MS`.
 * `getOrchestratorToken` serves an entry in two cases only: when its sysRedis read fails,
 * and for `WRITE_DEGRADED_WINDOW_MS` after a failed writeback to the sysRedis hash. It never
 * writes an entry back to the hash, so an entry holding a revoked key cannot outlive that
 * TTL or spread to other pods. To revoke a user's orchestrator tokens, call
 * `expireUserApiKeys` (`src/server/services/api-key.service.ts`): it expires the rows,
 * evicts them from the bearer-path cache and drops the hash entry, so the next call mints
 * afresh. In either case above, a pod can still serve an entry cached before the
 * revocation, for up to the TTL.
 *
 * Cross-user mints (the `moderatorProcedure.queryUserGeneratedImages` path) bypass this
 * cache via the `bypassCache` arg on `getOrchestratorToken`, so a moderator session never
 * leaves another user's token cached on the pods it touched.
 *
 * KNOWN BEHAVIOR (mint timeout)
 * -----------------------------
 * `mint()` is wrapped in `Promise.race` against a configurable timeout
 * (`ORCHESTRATOR_TOKEN_CACHE_MINT_TIMEOUT_MS`, default 5s; 0 disables).
 * Without a timeout, a Postgres failover or PgBouncer reserve_pool
 * exhaustion could leave the `inflight` Map slot held by a promise that
 * never settles. Subsequent same-user callers would attach to that dead
 * promise forever. The timeout rejects the awaiting promise, which fires
 * the `.finally()` that clears the inflight slot so the next caller gets
 * a fresh attempt.
 *
 * Default 5_000ms — well below the 10s kubelet liveness probe timeout
 * (a stalled mint that hits the timeout simultaneously with a probe
 * would cascade into pod-eviction), well above ApiKey INSERT p99. Set
 * to 0 to disable the timeout entirely (debug knob; not for prod).
 */

import { LRUCache } from 'lru-cache';
import { observeTokenIdentityMismatch } from '~/server/orchestrator/orchestrator-identity-metrics';
import {
  decodeOwnedToken,
  encodeOwnedToken,
} from '~/server/orchestrator/orchestrator-token-identity';
import { cacheHitCounter, cacheMissCounter } from '~/server/prom/client';

const CACHE_NAME = 'orchestrator-token-cold-mint';
const CACHE_TYPE = 'lruCache';

// 50k entries × ~60s TTL. An active-user set in the low
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

// Hard upper bound on how long we will await a `mint()` call before
// rejecting and freeing the inflight slot. `0` disables the timeout
// entirely (mint is awaited indefinitely — pre-this-PR behaviour). The
// default (5s) is well above any healthy ApiKey INSERT P99 but well
// below the 10s kubelet liveness probe timeout — a stalled mint that
// hits the timeout simultaneously with a probe would otherwise cascade
// into pod eviction (the round-4 audit caught that 10s == probe timeout
// risked synchronization). 5s leaves a 5s probe headroom while staying
// well above any healthy mint duration.
const DEFAULT_MINT_TIMEOUT_MS = 5_000;
const MINT_TIMEOUT_MS = readNonNegativeInt(
  'ORCHESTRATOR_TOKEN_CACHE_MINT_TIMEOUT_MS',
  DEFAULT_MINT_TIMEOUT_MS
);

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
 *
 * `readCache: false` still coalesces and refreshes the entry but never serves one: an entry can
 * hold a key revoked since it was cached, so only a caller with no better source should take it.
 */
export async function getOrMintCachedToken(
  userId: number,
  mint: () => Promise<string>,
  { readCache = true }: { readCache?: boolean } = {}
): Promise<string> {
  // Kill-switch: when `ORCHESTRATOR_TOKEN_CACHE_MAX=0`, bypass both the
  // cache AND the coalescing layer. N concurrent callers all hit `mint()`
  // directly — same behaviour as before this module existed. No counters
  // fire (cache is conceptually absent).
  if (CACHE_DISABLED || !tokenCache) {
    return mint();
  }

  // Entries carry the userId they were minted for, re-checked here rather than inferred
  // from the key that found them — see orchestrator-token-identity.ts. Anything not owned
  // by this user falls through to a fresh mint, so a poisoned entry costs a DB round-trip
  // instead of billing the wrong account.
  if (readCache) {
    const owned = decodeOwnedToken(tokenCache.get(userId), userId);
    if (owned.outcome === 'ok' && owned.token) {
      cacheHitCounter.inc({ cache_name: CACHE_NAME, cache_type: CACHE_TYPE });
      return owned.token;
    }
    if (owned.outcome === 'mismatch') observeTokenIdentityMismatch('lru');
  }

  const pending = inflight.get(userId);
  if (pending) {
    // Coalesce: another request for this user is already minting. Share
    // its promise. Still counts as a miss — the DB call is happening,
    // we're just not duplicating it.
    cacheMissCounter.inc({ cache_name: CACHE_NAME, cache_type: CACHE_TYPE });
    // Verified like a cache hit, and for a stronger reason: this map is the ONE structure
    // here that deliberately hands one user's mint result to a different caller, which
    // makes it the closest analogue of the fault the encoding exists to catch. The shared
    // promise therefore resolves ENCODED, and every consumer re-checks the owner.
    return unwrapInflight(pending, userId, mint);
  }

  cacheMissCounter.inc({ cache_name: CACHE_NAME, cache_type: CACHE_TYPE });

  const promise = (async () => {
    // Track the timeout handle so we can cancel it as soon as mint()
    // settles — otherwise a fast-resolving mint would still pin the
    // setTimeout reference until the timeout fires (allocates a stale
    // closure per mint, and prevents the GC from collecting the user's
    // tail-state). `.unref()` is belt-and-suspenders for short-lived
    // Node workers / scripts that import this module — the event loop
    // shouldn't be held alive by an outstanding mint timeout.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const mintPromise =
        MINT_TIMEOUT_MS > 0
          ? Promise.race<string>([
              mint(),
              new Promise<never>((_, reject) => {
                timeoutHandle = setTimeout(
                  () =>
                    reject(
                      new Error(
                        `getOrMintCachedToken: mint timed out after ${MINT_TIMEOUT_MS}ms for user ${userId}`
                      )
                    ),
                  MINT_TIMEOUT_MS
                );
                // Do not hold the event loop open solely for this timer.
                timeoutHandle.unref?.();
              }),
            ])
          : mint();

      const token = await mintPromise;
      const encoded = encodeOwnedToken(userId, token);
      tokenCache.set(userId, encoded);
      return encoded;
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      // Always clear the in-flight slot, even on rejection or timeout —
      // otherwise a single transient mint failure (or a stuck Postgres
      // failover that hits the MINT_TIMEOUT_MS guard above) would wedge
      // all future requests for this user behind a dead promise.
      inflight.delete(userId);
    }
  })();

  inflight.set(userId, promise);
  return unwrapInflight(promise, userId, mint);
}

/**
 * Strip the owner off a shared in-flight result, refusing it if the owner is not this caller.
 * Unreachable while the promise and the check share one `userId` binding — which is the point:
 * the check costs nothing and is the only thing standing between a future refactor of this map
 * and the failure it would reintroduce. A refusal re-mints rather than throwing, so the caller
 * that lost the race still gets served; it cannot stampede, because it cannot happen.
 */
async function unwrapInflight(
  pending: Promise<string>,
  userId: number,
  mint: () => Promise<string>
): Promise<string> {
  const owned = decodeOwnedToken(await pending, userId);
  if (owned.outcome === 'ok' && owned.token) return owned.token;
  if (owned.outcome === 'mismatch') observeTokenIdentityMismatch('lru');
  return mint();
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
  /**
   * Write a RAW entry, bypassing the encode step, so a test can stage the state
   * this cache is supposed to refuse. Nothing in the code can produce a wrongly
   * owned entry on purpose, which is exactly why the guard against one would
   * otherwise be untestable — and an untested guard is one a refactor deletes.
   */
  poison(userId: number, rawValue: string) {
    // Throws rather than no-ops when the cache is disabled: a silent no-op would leave every
    // test that stages a poisoned entry asserting nothing, and passing for that reason.
    if (!tokenCache) throw new Error('__testing.poison: cache is disabled, nothing was staged');
    tokenCache.set(userId, rawValue);
  },
  // PR #2333 round-4: explicit cleanup for HMR safety in dev + test
  // isolation. `LRUCache` with `ttl > 0` + `ttlAutopurge: true` registers
  // a per-entry `setTimeout` on every `set()` to drive the autopurge.
  // Those timers anchor the cache instance reachable for up to TTL_MS
  // after the last write — under Next.js dev HMR, each edit to this
  // module leaves the OLD `tokenCache` reachable until those timers
  // drain, and under vitest's `vi.resetModules()` flow, each dynamic
  // import leaves the prior module instance similarly anchored.
  //
  // `tokenCache.clear()` drops all entries (and cancels their pending
  // ttlAutopurge `setTimeout`s — that is the load-bearing call here),
  // and we also clear the `inflight` Map so awaiting promises don't
  // keep the module reachable past intent.
  //
  // Production callers must NOT invoke this — it is purely a hook for
  // HMR cleanup and test isolation. `__testing.clear()` is the public
  // test-suite reset; `destroy()` is the "module is going away" hook.
  destroy() {
    tokenCache?.clear();
    inflight.clear();
  },
};
