import {
  createCacheRedis,
  createSysRedis,
  type RedisCacheClient,
  type RedisSysClient,
} from '@civitai/redis';

// Redis clients for the moderator app. The builders eagerly connect, so we defer them behind lazy getters
// — a missing REDIS_URL/REDIS_SYS_URL then fails on first use, not at boot. Env comes from process.env
// (vite.config loads .env into it); loadRedisEnv needs BOTH urls.
let cacheClient: RedisCacheClient | undefined;
let sysClient: RedisSysClient | undefined;

export function getRedis(): RedisCacheClient {
  if (!cacheClient) cacheClient = createCacheRedis();
  return cacheClient;
}

// sysRedis — the shared system cluster (feed/existence caches, etc.), same instance the main app reads.
export function getSysRedis(): RedisSysClient {
  if (!sysClient) sysClient = createSysRedis();
  return sysClient;
}
