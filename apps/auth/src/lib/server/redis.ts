import { createCacheRedis, createSysRedis, type RedisCacheClient, type RedisSysClient } from '@civitai/redis';
import { env } from '$env/dynamic/private';

// The hub's two Redis clients, each lazy and memoized HERE so the whole app shares ONE cache + ONE sys
// connection (the registry + session producer both go through getSysRedis). Built on first use, never at
// module-load, so `vite build` doesn't connect. We use the single-purpose factories (createCacheRedis /
// createSysRedis) so each call builds ONLY the client it needs — `createRedisClients` would build and
// connect both. Returns null when the relevant URL isn't configured, so callers degrade (rate-limit fails
// open, blocklist falls back to the DB, registry → no-op).

let _redis: RedisCacheClient | null | undefined;

export function getRedis(): RedisCacheClient | null {
  if (_redis !== undefined) return _redis;
  if (!env.REDIS_URL) return (_redis = null);
  return (_redis = createCacheRedis());
}

let _sysRedis: RedisSysClient | null | undefined;

// The SYSTEM redis — separate instance from the cache redis. Used by the session producer (permissions
// map) and the session registry (revocation). Null when REDIS_SYS_URL isn't configured.
export function getSysRedis(): RedisSysClient | null {
  if (_sysRedis !== undefined) return _sysRedis;
  if (!env.REDIS_SYS_URL) return (_sysRedis = null);
  return (_sysRedis = createSysRedis());
}
