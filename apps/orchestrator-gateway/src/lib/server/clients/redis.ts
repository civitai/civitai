// The service's two Redis clients — the cache redis (fetchThroughCache for generation status/config in
// later phases) and the sysRedis (GENERATION.TOKENS cache + generation-version gate + budget counters).
// Both lazy + memoized HERE so the whole process shares ONE cache + ONE sys connection. Built on first
// use, never at module load, so the bundler/build never connects. Returns null when the relevant URL isn't
// configured, so callers degrade. Mirrors apps/auth/src/lib/server/redis.ts exactly (single-purpose
// factories so each call builds ONLY the client it needs).
//
// P0: these are constructed + connect-config-wired to prove the @civitai/redis import + env contract. No
// feature reads them yet — the GENERATION.TOKENS / fetchThroughCache usage moves in P1/P2.

import {
  createCacheRedis,
  createSysRedis,
  type RedisCacheClient,
  type RedisSysClient,
} from '@civitai/redis';

let _redis: RedisCacheClient | null | undefined;

/** Main cache redis (next-redis-cluster). Null when REDIS_URL isn't configured. */
export function getRedis(): RedisCacheClient | null {
  if (_redis !== undefined) return _redis;
  if (!process.env.REDIS_URL) return (_redis = null);
  return (_redis = createCacheRedis());
}

let _sysRedis: RedisSysClient | null | undefined;

/**
 * The SYSTEM redis — separate instance from the cache redis. Holds the orchestrator-token cache
 * (GENERATION.TOKENS) + generation-version gate + block budget counters. Null when REDIS_SYS_URL isn't
 * configured (or, in prod, discovered via REDIS_SYS_SENTINELS — @civitai/redis builds the client via
 * Sentinel discovery when those are set; REDIS_SYS_URL still gates this factory + supplies the node auth).
 */
export function getSysRedis(): RedisSysClient | null {
  if (_sysRedis !== undefined) return _sysRedis;
  if (!process.env.REDIS_SYS_URL) return (_sysRedis = null);
  return (_sysRedis = createSysRedis());
}
