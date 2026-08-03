// Moved to @civitai/redis — it is a caching data store, and it lives beside the Redis caches it fronts
// as their L1 tier. Re-exported from the original path with this app's prom counters bound, so the
// existing consumers (and their `~/server/utils/lru-cache` imports) are unchanged.
import { createLruCache as createLruCacheBase, type LruCacheOptions } from '@civitai/redis';
import { cacheHitCounter, cacheMissCounter } from '~/server/prom/client';

export { roughSizeOf, type LruCacheOptions, type LruCacheInstance } from '@civitai/redis';

export function createLruCache<K, V extends NonNullable<unknown>>(options: LruCacheOptions<K, V>) {
  return createLruCacheBase<K, V>({
    metrics: {
      hit: (cache_name) => cacheHitCounter.inc({ cache_name, cache_type: 'lruCache' }),
      miss: (cache_name) => cacheMissCounter.inc({ cache_name, cache_type: 'lruCache' }),
    },
    ...options,
  });
}
