/**
 * In-process LRU with TTL — the L1 tier in front of this package's Redis caches (see ./cached-array,
 * which drives one via get/set). Lives here rather than in a general utils package because it is a
 * caching data store, and keeping it beside the L2 it fronts avoids a cross-package dependency.
 *
 * Metrics are optional and injected: the only counters this ever reports are for the `fetch()` wrapper,
 * and callers that drive get/set directly (like cached-array, which reports its own L1 hit/miss) don't
 * need them at all. That keeps this module free of any prom/app dependency.
 */

import { LRUCache } from 'lru-cache';

const DEFAULT_MAX_SIZE = 1000;
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Pragmatic retained-bytes estimator for a decoded JS value. Uses the UTF-16 JSON length (`* 2`) plus a
 * small fixed per-entry overhead, clamped to ≥1 (a `sizeCalculation` return of 0 is rejected by
 * lru-cache). It runs on each `set` (miss-fill, not on hits), so it stays cheap; it is an ESTIMATE for
 * bounding heap, not an exact `retainedSize`. Callers can override via `sizeCalculation`.
 */
export function roughSizeOf(value: unknown): number {
  let json: string;
  try {
    json = JSON.stringify(value) ?? '';
  } catch {
    json = ''; // circular/unserializable → fall back to the fixed overhead
  }
  return Math.max(1, json.length * 2 + 64);
}

/** Optional hit/miss reporting for the `fetch()` wrapper. */
export type LruCacheMetrics = {
  hit(name: string): void;
  miss(name: string): void;
};

export type LruCacheOptions<K, V extends NonNullable<unknown>> = {
  /** Maximum number of items in cache (default: 1000). Belt-and-suspenders entry cap. */
  max?: number;
  /**
   * Optional byte budget for the cache. When set, the LRU evicts to keep the sum of entry sizes ≤
   * maxSize (a deterministic heap cap), in ADDITION to `max`. Requires a `sizeCalculation` (defaults to
   * `roughSizeOf`).
   */
  maxSize?: number;
  /**
   * Per-value size estimator used when `maxSize` is set. Runs on each `set` (miss-fill). Defaults to
   * `roughSizeOf`. Must return a positive integer.
   */
  sizeCalculation?: (value: V, key: string) => number;
  /** TTL in milliseconds (default: 5 minutes). Set to 0 for no TTL. */
  ttl?: number;
  /**
   * When `fetchFn` REJECTS, `fetch()` serves this key's EXPIRED value instead of propagating the error;
   * it still throws when nothing was ever cached. Off by default — a caller with no safe stale answer
   * must see the failure. Enabling it also keeps an expired entry alive through a normal `get`
   * (`noDeleteOnStaleGet`), which is what leaves a value to fall back to.
   *
   * For a cache whose miss value is indistinguishable from a legitimate empty answer — page-access
   * grants, permission maps — this is the difference between a Redis blip and a lockout.
   */
  allowStale?: boolean;
  /** Name for metrics tracking */
  name: string;
  /** Function to generate cache key from input */
  keyFn: (input: K) => string;
  /** Function to fetch data on cache miss */
  fetchFn: (input: K) => Promise<V>;
  /** Reported by `fetch()` only. Omit when driving the cache via get/set. */
  metrics?: LruCacheMetrics;
};

/**
 * Creates an LRU cache that wraps an async fetch function.
 *
 * On cache hit, returns cached value. On cache miss, calls fetchFn and caches the result.
 *
 * @example
 * ```typescript
 * const userCache = createLruCache({
 *   name: 'user-cache',
 *   max: 1000,
 *   ttl: 60000, // 1 minute
 *   keyFn: (userId: number) => `user:${userId}`,
 *   fetchFn: async (userId) => await db.user.findUnique({ where: { id: userId } }),
 * });
 *
 * const user = await userCache.fetch(123);
 * ```
 */
export function createLruCache<K, V extends NonNullable<unknown>>(options: LruCacheOptions<K, V>) {
  const {
    max = DEFAULT_MAX_SIZE,
    maxSize,
    sizeCalculation,
    ttl = DEFAULT_TTL_MS,
    allowStale = false,
    name,
    keyFn,
    fetchFn,
    metrics,
  } = options;

  const cache = new LRUCache<string, V>({
    max,
    ttl: ttl > 0 ? ttl : undefined,
    // A normal `get` prunes an expired entry as it reports the miss, which would throw away the very
    // value the fetch-rejection fallback needs. Only enabled with `allowStale`, so nothing else changes
    // its eviction behavior.
    ...(allowStale ? { noDeleteOnStaleGet: true } : {}),
    // Byte cap (deterministic heap bound), enabled only when maxSize is set — lru-cache requires a
    // sizeCalculation whenever maxSize is present. Clamp the estimator to a positive integer.
    ...(maxSize
      ? {
          maxSize,
          sizeCalculation: (value: V, key: string) =>
            Math.max(1, Math.round((sizeCalculation ?? roughSizeOf)(value, key))),
        }
      : {}),
  });

  return {
    /** Get a value from cache or fetch it if not present */
    async fetch(input: K): Promise<V> {
      const key = keyFn(input);
      const cached = cache.get(key);

      if (cached !== undefined) {
        metrics?.hit(name);
        return cached;
      }

      metrics?.miss(name);
      try {
        const value = await fetchFn(input);
        cache.set(key, value);
        return value;
      } catch (err) {
        if (!allowStale) throw err;
        // Read stale explicitly rather than via the constructor flag: a constructor-level `allowStale`
        // would make the `get` above serve expired values too, and the entry would never refresh.
        const stale = cache.get(key, { allowStale: true });
        if (stale === undefined) throw err;
        return stale;
      }
    },

    /** Get a value from cache without fetching */
    get(input: K): V | undefined {
      const key = keyFn(input);
      return cache.get(key);
    },

    /** Manually set a value in cache */
    set(input: K, value: V): void {
      const key = keyFn(input);
      cache.set(key, value);
    },

    /** Delete a value from cache */
    delete(input: K): boolean {
      const key = keyFn(input);
      return cache.delete(key);
    },

    /** Clear all entries from cache */
    clear(): void {
      cache.clear();
    },

    /** Check if a key exists in cache */
    has(input: K): boolean {
      const key = keyFn(input);
      return cache.has(key);
    },

    /** Get cache statistics */
    getStats() {
      return { size: cache.size, max, ttl, name };
    },

    /** Get current cache size */
    get size(): number {
      return cache.size;
    },
  };
}

export type LruCacheInstance<K, V extends NonNullable<unknown>> = ReturnType<
  typeof createLruCache<K, V>
>;
