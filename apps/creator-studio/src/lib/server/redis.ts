import { createRedisClients, type RedisClients } from '@civitai/redis';

// App shim around `@civitai/redis`. `createRedisClients()` reads REDIS_URL + REDIS_SYS_URL from process.env
// (both required — the vite.config shim bridges .env → process.env). Lazily constructed (so `vite build` never
// instantiates it) and cached on globalThis (dev HMR reuse). getRedis() is the cache client used by $lib/server/cache.
const g = globalThis as unknown as { redisClients?: RedisClients };

function clients(): RedisClients {
  if (!g.redisClients) g.redisClients = createRedisClients();
  return g.redisClients;
}

export function getRedis() {
  return clients().redis;
}

export function getSysRedis() {
  return clients().sysRedis;
}
