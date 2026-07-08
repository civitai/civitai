import { createCacheRedis, type RedisCacheClient } from '@civitai/redis';

// Cache Redis client for the moderator app. `createCacheRedis` builds ONLY the cache client (not the sys
// client) and eagerly connects it, so we defer it out of module import behind a lazy getter — a missing
// REDIS_URL then fails on first use (the blocklist page) instead of crashing the whole app at boot.
// Env comes from process.env (vite.config loads .env into it); loadRedisEnv still needs BOTH redis URLs.
let client: RedisCacheClient | undefined;

export function getRedis(): RedisCacheClient {
  if (!client) client = createCacheRedis();
  return client;
}
