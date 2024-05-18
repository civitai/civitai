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

function getCache(legacyMode = false) {
  log('Creating Redis client');
  const client: RedisClientType = createClient({
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
  client.on('error', (err) => log(`Redis Error: ${err}`));
  client.on('connect', () => log('Redis connected'));
  client.on('reconnecting', () => log('Redis reconnecting'));
  client.on('ready', () => log('Redis ready!'));
  client.connect();

  return client;
}

export let redis: RedisClientType;
if (isProd) {
  redis = getCache();
} else {
  if (!global.globalRedis) global.globalRedis = getCache();
  redis = global.globalRedis;
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
    FILES_FOR_MODEL_VERSION: 'packed:caches:files-for-model-version',
    MULTIPLIERS_FOR_USER: 'packed:caches:multipliers-for-user',
    TAG_IDS_FOR_IMAGES: 'packed:caches:tagIdsForImages',
    COSMETICS: 'packed:caches:cosmetics',
    PROFILE_PICTURES: 'packed:caches:profile-pictures',
    IMAGES_FOR_MODEL_VERSION: 'packed:caches:images-for-model-version',
    EDGE_CACHED: 'packed:caches:edge-cache',
  },
  QUEUES: {
    BUCKETS: 'packed:queues:buckets',
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
