import {
  createCacheRedis,
  createSysRedis,
  type RedisCacheClient,
  type RedisSysClient,
} from '@civitai/redis';

let sysClient: RedisSysClient | undefined;
let cacheClient: RedisCacheClient | undefined;

export function getSysRedis(): RedisSysClient {
  if (!sysClient) sysClient = createSysRedis();
  return sysClient;
}

/** The shared cache cluster: rate limits and caches. A script here must keep to one hash slot. */
export function getCacheRedis(): RedisCacheClient {
  if (!cacheClient) cacheClient = createCacheRedis();
  return cacheClient;
}
