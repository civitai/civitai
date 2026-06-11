import { createRedisClients } from '@civitai/redis';
import { env } from '$env/dynamic/private';

// Shared app (cache) redis client. Lazy — built on first use, never at module-load, so `vite build`
// (which evaluates modules but makes no calls) doesn't try to connect. Returns null when REDIS_URL
// isn't configured, so callers can degrade (rate-limit fails open, blocklist falls back to the DB).
// createRedisClients() memoizes its clients, so this shares the same connection as the registry.
type CacheRedis = ReturnType<typeof createRedisClients>['redis'];

let _redis: CacheRedis | null | undefined;

export function getRedis(): CacheRedis | null {
  if (_redis !== undefined) return _redis;
  if (!env.REDIS_URL) return (_redis = null);
  return (_redis = createRedisClients().redis);
}
