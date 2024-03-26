import { createClient } from 'redis';
import type { RedisClientType } from 'redis';
import { env } from '~/env/server.mjs';
import { createLogger } from '~/utils/logging';
import { isProd } from '~/env/other';

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var globalRedis: RedisClientType | undefined;
  // eslint-disable-next-line no-var, vars-on-top
  var globalRedisLegacy: RedisClientType | undefined;
}

const log = createLogger('redis', 'green');

function getCache(legacyMode = false) {
  log('Creating Redis client');
  const redisInt: RedisClientType = createClient({
    url: env.REDIS_URL,
    socket: {
      reconnectStrategy(retries) {
        log(`Redis reconnecting, retry ${retries}`);
        return Math.min(retries * 100, 3000);
      },
      connectTimeout: env.REDIS_TIMEOUT,
    },
    legacyMode,
    pingInterval: 4 * 60 * 1000,
  });
  redisInt.on('error', (err) => log(`Redis Error: ${err}`));
  redisInt.on('connect', () => log('Redis connected'));
  redisInt.on('reconnecting', () => log('Redis reconnecting'));
  redisInt.on('ready', () => log('Redis ready!'));
  redisInt.connect();
  return redisInt;
}

export let redis: RedisClientType;
export let redisLegacy: RedisClientType;
if (isProd) {
  redis = getCache();
  redisLegacy = getCache(true);
} else {
  if (!global.globalRedis) global.globalRedis = getCache();
  if (!global.globalRedisLegacy) global.globalRedisLegacy = getCache(true);
  redis = global.globalRedis;
  redisLegacy = global.globalRedisLegacy;
}

export const REDIS_KEYS = {
  DOWNLOAD: {
    COUNT: 'download:count',
    LIMITS: 'download:limits',
  },
  TAG_IDS_FOR_IMAGES: 'tagIdsForImages',
  COSMETICS: 'cosmetics',
  PROFILE_PICTURES: 'profile-pictures',
  BUZZ_EVENTS: 'buzz-events',
  IMAGES_FOR_MODEL_VERSION: 'images-for-model-version',
  GENERATION: {
    RESOURCE_DATA: 'generation:resource-data',
    COUNT: 'generation:count',
    LIMITS: 'generation:limits',
    STATUS: 'generation:status',
  },
  TRAINING: {
    STATUS: 'training:status',
  },
  CLIENT: 'client',
  SYSTEM: {
    FEATURES: 'system:features',
    MODERATED_TAGS: 'system:moderated_tags',
    TAG_RULES: 'system:tag-rules',
    SYSTEM_TAGS: 'system:tags',
    PERMISSIONS: 'system:permissions',
    TAGS_NEEDING_REVIEW: 'system:tags-needing-review',
    HOME_EXCLUDED_TAGS: 'system:home-excluded-tags',
    NOTIFICATION_COUNTS: 'system:notification-counts',
  },
  CACHES: {
    FILES_FOR_MODEL_VERSION: 'caches:files-for-model-version',
    MULTIPLIERS_FOR_USER: 'caches:multipliers-for-user',
  },
  QUEUES: {
    BUCKETS: 'queues:buckets',
  },
  RESEARCH: {
    RATINGS_COUNT: 'research:ratings-count',
  },
  LIVE_NOW: 'live-now',
} as const;
