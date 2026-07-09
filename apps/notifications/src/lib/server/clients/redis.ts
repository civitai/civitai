// The app's cache redis client, built via @civitai/redis — replaces the external notification-server's
// hand-rolled `redis-client.ts` (the createCluster + watchdog + rebootstrap Proxy, ~250 lines of the
// §2a fork). @civitai/redis owns cluster discovery, the self-heal watchdog, and topology refresh now.
//
// Only the cache client is used (per-user unread counters). Lazy + memoized so the whole process shares
// ONE connection and importing this module never connects. Returns null when REDIS_URL isn't configured
// so callers degrade (the fan-out signal still fires; only the counter bump is skipped).

import { createCacheRedis, type RedisCacheClient } from '@civitai/redis';

let _redis: RedisCacheClient | null | undefined;

export function getRedis(): RedisCacheClient | null {
  if (_redis !== undefined) return _redis;
  if (!process.env.REDIS_URL) return (_redis = null);
  return (_redis = createCacheRedis());
}
