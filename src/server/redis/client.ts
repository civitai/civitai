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

  BUZZ_EVENTS: 'buzz-events',
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
    TAG_IDS_FOR_IMAGES: 'caches:tagIdsForImages',
    COSMETICS: 'caches:cosmetics',
    PROFILE_PICTURES: 'caches:profile-pictures',
    IMAGES_FOR_MODEL_VERSION: 'caches:images-for-model-version',
  },
  QUEUES: {
    BUCKETS: 'queues:buckets',
  },
  RESEARCH: {
    RATINGS_COUNT: 'research:ratings-count',
    RATINGS_PROGRESS: 'research:ratings-progress',
    RATINGS_TRACKS: 'research:ratings-tracks-2',
    RATINGS_SANITY_IDS: 'research:ratings-sanity-ids',
  },
  COUNTERS: {
    REDEMPTION_ATTEMPTS: 'counters:redemption-attempts',
    EMAIL_VERIFICATIONS: 'counters:email-verifications',
  },
  LIMITS: {
    EMAIL_VERIFICATIONS: 'limits:email-verifications',
  },
  LIVE_NOW: 'live-now',
} as const;
