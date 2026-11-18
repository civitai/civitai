import {
  createCacheRedis,
  createSysRedis,
  type RedisCacheClient,
  type RedisSysClient,
} from '@civitai/redis';

// Lazy: each builder eagerly connects, so a missing REDIS_URL / REDIS_SYS_URL fails on first use, not
// at boot. Callers treat a redis failure as fail-open.
let sysClient: RedisSysClient | undefined;
let cacheClient: RedisCacheClient | undefined;

// The shared system Redis — same instance the main app reads: durable state only (the orchestrator
// token cache, session revocations).
export function getSysRedis(): RedisSysClient {
  if (!sysClient) sysClient = createSysRedis();
  return sysClient;
}

// The shared cache cluster: cached ratings and the daily allowances. A MULTI or script here must
// keep to one hash slot.
export function getCacheRedis(): RedisCacheClient {
  if (!cacheClient) cacheClient = createCacheRedis();
  return cacheClient;
}
