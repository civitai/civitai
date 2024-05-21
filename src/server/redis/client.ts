import { createClient, commandOptions } from 'redis';
import type { RedisClientType, SetOptions } from 'redis';
import { env } from '~/env/server.mjs';
import { createLogger } from '~/utils/logging';
import { isProd } from '~/env/other';
import { pack, unpack } from 'msgpackr';

export interface PackedRedisClient extends RedisClientType {
  packed: {
    get<T>(key: string): Promise<T | null>;
    mGet<T>(keys: string[]): Promise<(T | null)[]>;
    set<T>(key: string, value: T, options?: SetOptions): Promise<void>;
    mSet(records: Record<string, unknown>, options?: SetOptions): Promise<void>;
    setNX<T>(key: string, value: T): Promise<void>;
    sAdd<T>(key: string, values: T[]): Promise<void>;
    sRemove<T>(key: string, value: T): Promise<void>;
    sMembers<T>(key: string): Promise<T[]>;
    hGet<T>(key: string, hashKey: string): Promise<T | null>;
    hSet<T>(key: string, hashKey: string, value: T): Promise<void>;
    hmSet<T>(key: string, records: Record<string, T>): Promise<void>;
    hmGet<T>(key: string, hashKeys: string[]): Promise<(T | null)[]>;
  };
}

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var globalRedis: PackedRedisClient | undefined;
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

  const client = baseClient as PackedRedisClient;
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

  return client;
}

export let redis: PackedRedisClient;
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
