import { pack, unpack } from 'msgpackr';
import type { RedisClientType, SetOptions } from 'redis';
import { commandOptions, createClient } from 'redis';
import { isProd } from '~/env/other';
import { env } from '~/env/server.mjs';
import { createLogger } from '~/utils/logging';

export interface CustomRedisClient extends RedisClientType {
  packed: {
    get<T>(key: string): Promise<T | null>;
    mGet<T>(keys: string[]): Promise<(T | null)[]>;
    set<T>(key: string, value: T, options?: SetOptions): Promise<void>;
    mSet(records: Record<string, unknown>, options?: SetOptions): Promise<void>;
    setNX<T>(key: string, value: T): Promise<void>;
    sAdd<T>(key: string, values: T[]): Promise<void>;
    sRemove<T>(key: string, value: T): Promise<void>;
    sPop<T>(key: string, count: number): Promise<T[]>;
    sMembers<T>(key: string): Promise<T[]>;
    hGet<T>(key: string, hashKey: string): Promise<T | null>;
    hGetAll<T>(key: string): Promise<{ [x: string]: T }>;
    hSet<T>(key: string, hashKey: string, value: T): Promise<void>;
    hmSet<T>(key: string, records: Record<string, T>): Promise<void>;
    hmGet<T>(key: string, hashKeys: string[]): Promise<(T | null)[]>;
  };
  purgeTags: (tag: string | string[]) => Promise<void>;
}

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var globalRedis: CustomRedisClient | undefined;
}

const log = createLogger('redis', 'green');

function getCache(legacyMode = false) {
  log('Creating Redis client');
  const baseClient: RedisClientType = createClient({
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
  baseClient.on('error', (err) => log(`Redis Error: ${err}`));
  baseClient.on('connect', () => log('Redis connected'));
  baseClient.on('reconnecting', () => log('Redis reconnecting'));
  baseClient.on('ready', () => log('Redis ready!'));
  baseClient.connect();

  const client = baseClient as CustomRedisClient;
  client.packed = {
    async get<T>(key: string): Promise<T | null> {
      const result = await client.get(commandOptions({ returnBuffers: true }), key);
      return result ? unpack(result) : null;
    },

    async mGet<T>(keys: string[]): Promise<(T | null)[]> {
      const results = await client.mGet(commandOptions({ returnBuffers: true }), keys);
      return results.map((result) => (result ? unpack(result) : null));
    },

    async set<T>(key: string, value: T, options?: SetOptions): Promise<void> {
      await client.set(key, pack(value), options);
    },

    async mSet(records: Record<string, unknown>): Promise<void> {
      const packedRecords: [string, Buffer][] = Object.entries(records).map(([k, v]) => [
        k,
        pack(v),
      ]);
      await client.mSet(packedRecords);
    },

    async setNX<T>(key: string, value: T): Promise<void> {
      await client.setNX(key, pack(value));
    },

    async sAdd<T>(key: string, values: T[]): Promise<void> {
      await client.sAdd(key, values.map(pack));
    },

    async sPop<T>(key: string, count: number): Promise<T[]> {
      const packedValues = await client.sPop(commandOptions({ returnBuffers: true }), key, count);
      return packedValues.map((value) => unpack(value));
    },

    async sRemove<T>(key: string, value: T): Promise<void> {
      await client.sRem(key, pack(value));
    },

    async sMembers<T>(key: string): Promise<T[]> {
      const packedValues = await client.sMembers(commandOptions({ returnBuffers: true }), key);
      return packedValues.map((value) => unpack(value));
    },

    async hGet<T>(key: string, hashKey: string): Promise<T | null> {
      const result = await client.hGet(commandOptions({ returnBuffers: true }), key, hashKey);
      return result ? unpack(result) : null;
    },

    async hGetAll<T>(key: string): Promise<{ [x: string]: T }> {
      const results = await client.hGetAll(commandOptions({ returnBuffers: true }), key);
      return Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v ? unpack(v) : null]));
    },

    async hSet<T>(key: string, hashKey: string, value: T): Promise<void> {
      await client.hSet(key, hashKey, pack(value));
    },

    async hmSet<T>(key: string, records: Record<string, T>): Promise<void> {
      const packedRecords: Record<string, Buffer> = {};
      for (const [hashKey, value] of Object.entries(records)) {
        packedRecords[hashKey] = pack(value);
      }
      await client.hSet(key, packedRecords);
    },

    async hmGet<T>(key: string, hashKeys: string[]): Promise<(T | null)[]> {
      const results = await client.hmGet(commandOptions({ returnBuffers: true }), key, hashKeys);
      return results.map((result) => (result ? unpack(result) : null));
    },
  };
  client.purgeTags = async (tag: string | string[]) => {
    const tags = Array.isArray(tag) ? tag : [tag];
    for (const tag of tags) {
      const cacheKey = REDIS_KEYS.CACHES.TAGGED_CACHE + ':' + tag;
      const count = await client.sCard(cacheKey);
      let processed = 0;
      while (true) {
        const keys = await client.sPop(cacheKey, 1000);
        const hasOverfetched = processed > count * 1.5;
        if (!keys.length || hasOverfetched) break;
        await client.del(keys);
        processed += keys.length;
      }
    }
  };

  return client;
}

export let redis: CustomRedisClient;
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
    RESOURCE_DATA: 'packed:generation:resource-data',
    COUNT: 'generation:count',
    LIMITS: 'generation:limits',
    STATUS: 'generation:status',
    WORKFLOWS: 'generation:workflows',
  },
  TRAINING: {
    STATUS: 'training:status',
  },
  CLIENT: 'client',
  SYSTEM: {
    FEATURES: 'system:features',
    MODERATED_TAGS: 'packed:system:moderated_tags',
    TAG_RULES: 'system:tag-rules',
    SYSTEM_TAGS: 'system:tags',
    PERMISSIONS: 'system:permissions',
    TAGS_NEEDING_REVIEW: 'system:tags-needing-review',
    TAGS_BLOCKED: 'system:tags-blocked',
    HOME_EXCLUDED_TAGS: 'system:home-excluded-tags',
    NOTIFICATION_COUNTS: 'system:notification-counts',
    USER_SCORE_MULTIPLIERS: 'system:user-score-multipliers',
    NON_CRITICAL_HEALTHCHECKS: 'non-critical-healthchecks',
    DISABLED_HEALTHCHECKS: 'disabled-healthchecks',
    BLOCKLIST: 'system:blocklist',
  },
  CACHES: {
    FILES_FOR_MODEL_VERSION: 'packed:caches:files-for-model-version',
    MULTIPLIERS_FOR_USER: 'packed:caches:multipliers-for-user',
    TAG_IDS_FOR_IMAGES: 'packed:caches:tag-ids-for-images',
    COSMETICS: 'packed:caches:cosmetics',
    PROFILE_PICTURES: 'packed:caches:profile-pictures',
    IMAGES_FOR_MODEL_VERSION: 'packed:caches:images-for-model-version-2',
    EDGE_CACHED: 'packed:caches:edge-cache',
    TAGGED_CACHE: 'packed:caches:tagged-cache',
    DATA_FOR_MODEL: 'packed:caches:data-for-model',
    BLOCKED_USERS: 'packed:caches:blocked-users',
    BLOCKED_BY_USERS: 'packed:caches:blocked-by-users',
    BASIC_USERS: 'packed:caches:basic-users',
    BASIC_TAGS: 'packed:caches:basic-tags',
    ENTITY_AVAILABILITY: {
      MODEL_VERSIONS: 'packed:caches:entity-availability:model-versions',
    },
    OVERVIEW_USERS: 'packed:caches:overview-users',
    IMAGE_META: 'packed:caches:image-meta',
    FEATURED_MODELS: 'packed:featured-models',
    ANNOUNCEMENTS: 'packed:caches:image-meta',
  },
  INDEX_UPDATES: {
    IMAGE_METRIC: 'index-updates:image-metric',
  },
  QUEUES: {
    BUCKETS: 'queues:buckets',
    SEEN_IMAGES: 'queues:seen-images',
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
    HISTORY_DOWNLOADS: 'counters:history-downloads',
  },
  LIMITS: {
    EMAIL_VERIFICATIONS: 'limits:email-verifications',
    HISTORY_DOWNLOADS: 'limits:history-downloads',
  },
  LIVE_NOW: 'live-now',
  INDEXES: {
    IMAGE_DELETED: 'indexes:image-deleted',
  },
} as const;
