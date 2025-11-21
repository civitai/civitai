// Generic TTL cache with access-based refresh

import { cacheHitCounter, cacheMissCounter } from '~/server/prom/client';

type CacheEntry<T> = {
  data: T;
  expiresAt: number;
};

export type TtlCacheOptions = {
  /** TTL in milliseconds (default: 1 hour) */
  ttl?: number;
  /** Whether to refresh TTL on access (default: true) */
  refreshOnAccess?: boolean;
  /** Optional name for metrics tracking (default: 'unnamed') */
  name?: string;
};

/**
 * Generic TTL (Time To Live) cache with access-based refresh
 *
 * Features:
 * - Configurable TTL per cache instance
 * - Optional TTL refresh on access
 * - Batch get/set operations
 * - Automatic cleanup of expired entries
 * - Cache statistics
 *
 * @template T The type of data to cache
 *
 * @example
 * ```typescript
 * // Simple string cache
 * const cache = new TtlCache<string>({ ttl: 5 * 60 * 1000 }); // 5 minutes
 * cache.set('key1', 'value1');
 * const value = cache.get('key1'); // 'value1'
 *
 * // Object cache with custom key extraction
 * type User = { id: number; name: string };
 * const userCache = new TtlCache<User>();
 * userCache.set('user:123', { id: 123, name: 'John' });
 *
 * // Batch operations
 * const users = [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }];
 * userCache.setMany(users.map(u => ({ key: `user:${u.id}`, data: u })));
 * ```
 */
export class TtlCache<T> {
  private cache: Map<string, CacheEntry<T>> = new Map();
  private ttl: number;
  private refreshOnAccess: boolean;
  private name: string;

  constructor(options: TtlCacheOptions = {}) {
    this.ttl = options.ttl ?? 60 * 60 * 1000; // Default 1 hour
    this.refreshOnAccess = options.refreshOnAccess ?? true;
    this.name = options.name ?? 'unnamed';
  }

  /**
   * Get a value from cache by key
   * Optionally refreshes TTL on access
   *
   * @param key Cache key
   * @returns Cached data or null if not found/expired
   */
  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) {
      cacheMissCounter.inc({ cache_name: this.name, cache_type: 'ttlCache' });
      return null;
    }

    const now = Date.now();
    if (now > entry.expiresAt) {
      // Entry expired, remove it
      this.cache.delete(key);
      cacheMissCounter.inc({ cache_name: this.name, cache_type: 'ttlCache' });
      return null;
    }

    // Cache hit
    cacheHitCounter.inc({ cache_name: this.name, cache_type: 'ttlCache' });

    // Refresh TTL on access if enabled
    if (this.refreshOnAccess) {
      entry.expiresAt = now + this.ttl;
    }

    return entry.data;
  }

  /**
   * Set a value in cache
   *
   * @param key Cache key
   * @param data Data to cache
   */
  set(key: string, data: T): void {
    this.cache.set(key, {
      data,
      expiresAt: Date.now() + this.ttl,
    });
  }

  /**
   * Set multiple values in cache
   *
   * @param entries Array of key-data pairs
   */
  setMany(entries: Array<{ key: string; data: T }>): void {
    const expiresAt = Date.now() + this.ttl;
    for (const { key, data } of entries) {
      this.cache.set(key, {
        data,
        expiresAt,
      });
    }
  }

  /**
   * Get multiple values from cache
   * Returns found entries and list of missing keys
   *
   * @param keys Array of cache keys
   * @returns Object with found entries map and missing keys array
   */
  getMany(keys: string[]): {
    found: Map<string, T>;
    missing: string[];
  } {
    const found = new Map<string, T>();
    const missing: string[] = [];

    for (const key of keys) {
      const data = this.get(key);
      if (data !== null) {
        found.set(key, data);
      } else {
        missing.push(key);
      }
    }

    return { found, missing };
  }

  /**
   * Check if a key exists in cache and is not expired
   *
   * @param key Cache key
   * @returns true if key exists and not expired
   */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    const now = Date.now();
    if (now > entry.expiresAt) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Delete a key from cache
   *
   * @param key Cache key
   * @returns true if key was deleted
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear all entries from cache
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Clear all expired entries from cache
   * Should be called periodically to free memory
   *
   * @returns Number of entries removed
   */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        removed++;
      }
    }

    return removed;
  }

  /**
   * Get cache statistics
   *
   * @returns Object with cache size and entry details
   */
  getStats() {
    const now = Date.now();
    return {
      size: this.cache.size,
      ttl: this.ttl,
      refreshOnAccess: this.refreshOnAccess,
      entries: Array.from(this.cache.entries()).map(([key, entry]) => ({
        key,
        expiresIn: Math.max(0, entry.expiresAt - now),
        expired: now > entry.expiresAt,
      })),
    };
  }

  /**
   * Get the number of entries in cache (including expired)
   */
  get size(): number {
    return this.cache.size;
  }
}
