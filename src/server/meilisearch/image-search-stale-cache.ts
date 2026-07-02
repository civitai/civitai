import { createHash } from 'crypto';
import type { RedisKeyTemplateCache } from '~/server/redis/client';
import { REDIS_KEYS } from '~/server/redis/client';

/**
 * Graceful stale-serve ("stale-but-fast") for the Meili-backed image feed.
 *
 * WHY: civitai-dp-prod's metricsSearch Meilisearch backend (index > node RAM)
 * chronically browns out during waves — p99 3–6s, timeouts, circuit trips. When
 * that happens the feed's Meili read throws `MeiliCallTimeoutError` (wrapper
 * timeout / circuit-open) or a transient SDK error, and `getAllImagesIndex`
 * maps it to a hard 503 — the feed goes UNUSABLE exactly when traffic is
 * highest. This module lets the feed serve the LAST-GOOD result fast instead.
 *
 * ── NSFW / visibility SAFETY (the load-bearing property) ────────────────────
 * The cache key is a strong (sha256) hash of the FULLY-COMPOSED Meili request:
 * the `filter` string, the `sort`, `limit`, and `offset`. In
 * getImagesFromSearchPreFilter that filter string is the SOLE determinant of
 * which documents Meili is allowed to return, and it encodes EVERY visibility
 * dimension:
 *   - browsingLevel        → `nsfwLevel IN [...]` / `combinedNsfwLevel IN [...]`
 *   - moderator status     → the mod-only carve-outs (poi/minor/blockedFor, 0-level)
 *   - the viewer's own id   → `OR "userId" = <id>` own-carve-outs on the
 *                             availability / blocked / nsfw / published clauses
 *   - hidden / followed     → resolved to explicit id-lists baked into the filter
 *   - excluded tags / users → `tagIds NOT IN [...]` / `userId NOT IN [...]`
 *   - tags/tools/types/baseModels/period/postId/modelVersionId/etc.
 *
 * Therefore two requests that hash to the same key have BYTE-IDENTICAL
 * visibility semantics, and serving one's stored result for the other cannot
 * leak content across browsing levels or across per-user visibility scopes. A
 * different browsingLevel → a different `nsfwLevel IN [...]` clause → a different
 * filter string → a different key (asserted in the unit tests). Because the own-
 * carve-out embeds `currentUserId`, any personalized query is automatically
 * scoped to that user; anonymous / browsing-level-only queries (the dominant,
 * shared traffic) share a key safely.
 *
 * sha256 (not the app's 32-bit hashifyObject) is used DELIBERATELY: a 32-bit
 * hash collides at ~65k distinct keys, and a collision here would serve one
 * visibility scope's content under another — an NSFW leak. A 256-bit digest
 * makes that collision probability negligible.
 *
 * ── RESIDUAL RISK (documented, bounded) ─────────────────────────────────────
 * A cached doc carries the `nsfwLevel` it had at cache time. If an image is
 * re-rated (e.g. PG → X) AFTER being cached, a stale serve could show it under
 * the old level for up to the stale bound. This is the SAME eventual-consistency
 * window that already exists in the live Meili index (re-rate → reindex lag is
 * minutes) and in BitDex; the stale bound merely adds at most `MEILI_STALE_MAX_AGE`
 * on top. Keep the bound tight to keep that additive window small.
 *
 * ── BOUND ───────────────────────────────────────────────────────────────────
 * Stale is served ONLY if the entry is within `MEILI_STALE_MAX_AGE_MS`. The
 * bound is enforced two ways: Redis `EX` expiry AND an explicit `cachedAt` check
 * on read (belt-and-suspenders + unit-testable). Past the bound we fall through
 * to today's behavior (throw → 503).
 */

/**
 * Maximum age a last-good entry may be served at. 5 minutes: long enough to ride
 * out a typical brownout / circuit-cooldown cycle, short enough that the additive
 * nsfwLevel-drift window (see RESIDUAL RISK) stays small. The feed's `sortAt` is
 * already minute-snapped so content granularity below this is moot.
 */
export const MEILI_STALE_MAX_AGE_MS = 5 * 60 * 1000;
export const MEILI_STALE_MAX_AGE_SECONDS = Math.floor(MEILI_STALE_MAX_AGE_MS / 1000);

/** Stored shape: the cached value plus the wall-clock time it was written. */
export type StaleEntry<T> = { value: T; cachedAt: number };

/**
 * Minimal surface of the packed redis client this module needs. Declared here
 * (rather than importing the concrete client) so callers inject the real client
 * and tests inject a fake — keeping the module free of the redis singleton.
 */
export interface StalePackedClient {
  packed: {
    get<T>(key: RedisKeyTemplateCache): Promise<T | null>;
    set<T>(key: RedisKeyTemplateCache, value: T, options?: { EX?: number }): Promise<void>;
  };
}

/**
 * Build the stale-cache key from the fully-composed Meili request. See the
 * module header for why hashing the composed request (filter+sort+limit+offset)
 * is the NSFW-safe key: the filter string is the exact visibility query.
 */
export function buildImageSearchStaleKey(parts: {
  index: string;
  filter: string;
  sort: readonly string[];
  limit: number;
  offset: number;
}): RedisKeyTemplateCache {
  // Canonical, order-stable serialization of the discriminating fields.
  const canonical = JSON.stringify([
    parts.index,
    parts.filter,
    parts.sort,
    parts.limit,
    parts.offset,
  ]);
  const digest = createHash('sha256').update(canonical).digest('hex');
  return `${REDIS_KEYS.CACHES.IMAGE_SEARCH_STALE}:${digest}` as RedisKeyTemplateCache;
}

/**
 * Write the last-good result. Fire-and-forget by design: the happy-path return
 * value is NOT altered and the caller does not await this, so a slow/failed
 * cache write never adds latency to (nor can it fail) a successful search. The
 * `EX` bound means keys self-expire at the stale ceiling.
 */
export function writeImageSearchStale<T>(
  client: StalePackedClient,
  key: RedisKeyTemplateCache,
  value: T,
  now: number = Date.now()
): void {
  const entry: StaleEntry<T> = { value, cachedAt: now };
  void Promise.resolve()
    .then(() => client.packed.set(key, entry, { EX: MEILI_STALE_MAX_AGE_SECONDS }))
    .catch(() => {
      // Best-effort: a stale-cache write failure must never surface on the feed.
    });
}

/**
 * Read the last-good result, enforcing the stale bound. Returns the cached VALUE
 * only when an entry exists AND is within `MEILI_STALE_MAX_AGE_MS`; otherwise
 * null (so the caller falls through to today's throw). Never throws — a redis
 * read failure resolves to null.
 */
export async function readImageSearchStale<T>(
  client: StalePackedClient,
  key: RedisKeyTemplateCache,
  now: number = Date.now()
): Promise<T | null> {
  let entry: StaleEntry<T> | null;
  try {
    entry = await client.packed.get<StaleEntry<T>>(key);
  } catch {
    return null;
  }
  if (!entry || typeof entry.cachedAt !== 'number') return null;
  if (now - entry.cachedAt > MEILI_STALE_MAX_AGE_MS) return null;
  return entry.value;
}

/**
 * Run a live Meili-backed read with graceful stale-serve on a recognized
 * transient failure.
 *
 * Semantics (all asserted in the unit tests):
 *   - Healthy: run() resolves → write last-good (fire-and-forget) → return the
 *     LIVE value byte-identically. No stale read. (Happy path unchanged.)
 *   - Transient failure + fresh last-good present → return the stale value and
 *     call onStaleServed() (the metric). The original error is NOT thrown.
 *   - Transient failure + no last-good / last-good past the bound → rethrow the
 *     original error (today's behavior → 503).
 *   - Non-recoverable failure (validation / auth / real bug) → rethrow WITHOUT
 *     consulting the cache. A genuine failure is never masked.
 *
 * A genuine empty result (run() resolves to `{ data: [], ... }`) returns via the
 * healthy path and is honored as-is — stale-serve only ever triggers inside the
 * catch, so "0 results" stays 0 results.
 */
export async function staleServeOnError<T>(opts: {
  run: () => Promise<T>;
  read: () => Promise<T | null>;
  write: (value: T) => void;
  isRecoverable: (err: unknown) => boolean;
  onStaleServed: () => void;
}): Promise<T> {
  try {
    const value = await opts.run();
    opts.write(value);
    return value;
  } catch (err) {
    if (opts.isRecoverable(err)) {
      // A stale read must never mask the original failure: if it throws, fall
      // through to rethrowing `err` (today's behavior). readImageSearchStale
      // already resolves to null on redis error, so this is belt-and-suspenders.
      let stale: T | null = null;
      try {
        stale = await opts.read();
      } catch {
        stale = null;
      }
      if (stale != null) {
        opts.onStaleServed();
        return stale;
      }
    }
    throw err;
  }
}
