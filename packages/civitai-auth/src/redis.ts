import { createCacheRedis, REDIS_KEYS, type RedisCacheClient } from '@civitai/redis';

// The auth package's auto redis access (thin-session resolution reads the shared cache on every request —
// see docs/thin-session-token-design.md). LAZY singleton: never instantiated at import, only on first
// resolve, so importing @civitai/auth (e.g. the edge-safe `verify` path) never connects to redis. Uses
// `createCacheRedis` (not `createRedisClients`) so we build ONLY the cache client — no discarded sys
// connection — and hold the real `RedisCacheClient` type rather than re-declaring a shim.

let _redis: RedisCacheClient | undefined;

/** The shared cache client (`@civitai/redis`'s `redis`), built lazily on first use. */
export function getCacheRedis(): RedisCacheClient {
  return (_redis ??= createCacheRedis());
}

/** The shared user-session cache key — `REDIS_KEYS.USER.SESSION:{userId}` (`session:data2:{userId}`), the
 *  one source of truth every consumer reads. The `as const` keeps it a `RedisKeyTemplateCache` literal so
 *  the typed-key client accepts it without a cast. */
export function sessionCacheKey(userId: number) {
  return `${REDIS_KEYS.USER.SESSION}:${userId}` as const;
}
