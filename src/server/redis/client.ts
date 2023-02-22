import { createClient } from 'redis';
import type { RedisClientType } from 'redis';
import { env } from '~/env/server.mjs';
import { createLogger } from '~/utils/logging';
import { isProd } from '~/env/other';

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var globalRedis: RedisClientType | undefined;
}

const log = createLogger('redis', 'green');

function getCache() {
  const redisInt: RedisClientType = createClient({
    url: env.REDIS_URL,
  });
  redisInt.on('error', (err) => log(`Redis Error: ${err}`));
  redisInt.on('connect', () => log('Redis connected'));
  redisInt.on('reconnecting', () => log('Redis reconnecting'));
  redisInt.on('ready', () => log('Redis ready!'));
  redisInt.connect();
  return redisInt;
}

export let redis: RedisClientType;
if (isProd) {
  redis = getCache();
} else {
  if (!global.globalRedis) global.globalRedis = getCache();
  redis = global.globalRedis;
}
