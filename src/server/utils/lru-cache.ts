/**
 * LRU (Least Recently Used) cache utility with TTL support
 *
 * This provides an in-memory cache that:
 * - Evicts least recently used items when max size is reached
 * - Supports optional TTL for automatic expiration
 * - Wraps async fetch functions for cache-miss handling
 */

import { LRUCache } from 'lru-cache';
import { cacheHitCounter, cacheMissCounter } from '~/server/prom/client';

const DEFAULT_MAX_SIZE = 1000;
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

export type LruCacheOptions<K, V extends {}> = {
  /** Maximum number of items in cache (default: 1000) */
  max?: number;
  /** TTL in milliseconds (default: 5 minutes). Set to 0 for no TTL. */
  ttl?: number;
  /** Name for metrics tracking */
  name: string;
  /** Function to generate cache key from input */
  keyFn: (input: K) => string;
  /** Function to fetch data on cache miss */
  fetchFn: (input: K) => Promise<V>;
};

/**
 * Creates an LRU cache that wraps an async fetch function.
 *
 * On cache hit, returns cached value.
 * On cache miss, calls fetchFn and caches the result.
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
export function createLruCache<K, V extends {}>(options: LruCacheOptions<K, V>) {
  const { max = DEFAULT_MAX_SIZE, ttl = DEFAULT_TTL_MS, name, keyFn, fetchFn } = options;

  const cache = new LRUCache<string, V>({
    max,
    ttl: ttl > 0 ? ttl : undefined,
  });

  return {
    /**
     * Get a value from cache or fetch it if not present
     */
    async fetch(input: K): Promise<V> {
      const key = keyFn(input);
      const cached = cache.get(key);

      if (cached !== undefined) {
        cacheHitCounter.inc({ cache_name: name, cache_type: 'lruCache' });
        return cached;
      }

      cacheMissCounter.inc({ cache_name: name, cache_type: 'lruCache' });
      const value = await fetchFn(input);
      cache.set(key, value);
      return value;
    },

    /**
     * Get a value from cache without fetching
     */
    get(input: K): V | undefined {
      const key = keyFn(input);
      return cache.get(key);
    },

    /**
     * Manually set a value in cache
     */
    set(input: K, value: V): void {
      const key = keyFn(input);
      cache.set(key, value);
    },

    /**
     * Delete a value from cache
     */
    delete(input: K): boolean {
      const key = keyFn(input);
      return cache.delete(key);
    },

    /**
     * Clear all entries from cache
     */
    clear(): void {
      cache.clear();
    },

    /**
     * Check if a key exists in cache
     */
    has(input: K): boolean {
      const key = keyFn(input);
      return cache.has(key);
    },

    /**
     * Get cache statistics
     */
    getStats() {
      return {
        size: cache.size,
        max,
        ttl,
        name,
      };
    },

    /**
     * Get current cache size
     */
    get size(): number {
      return cache.size;
    },
  };
}

export type LruCacheInstance<K, V extends {}> = ReturnType<typeof createLruCache<K, V>>;
