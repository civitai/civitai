import {
  createCacheRedis,
  createSysRedis,
  type RedisCacheClient,
  type RedisSysClient,
} from '@civitai/redis';

// Lazy getters — the builders eagerly connect, so a missing REDIS_URL/REDIS_SYS_URL fails on first use, not
// at boot.
let cacheClient: RedisCacheClient | undefined;
let sysClient: RedisSysClient | undefined;

export function getRedis(): RedisCacheClient {
  if (!cacheClient) cacheClient = createCacheRedis();
  return cacheClient;
}

// The shared system cluster — same instance the main app reads.
export function getSysRedis(): RedisSysClient {
  if (!sysClient) sysClient = createSysRedis();
  return sysClient;
}
