import { pack, unpack } from 'msgpackr';
import type { RedisClientType, SetOptions } from 'redis';
import { commandOptions, createClient } from 'redis';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import { createLogger } from '~/utils/logging';
import { slugit } from '~/utils/string-helpers';

export type RedisKeyStringsCache = Values<typeof REDIS_KEYS>;
export type RedisKeyStringsSys = Values<typeof REDIS_SYS_KEYS>;

export type RedisKeyTemplateCache = `${RedisKeyStringsCache}${'' | `:${string}`}`;
export type RedisKeyTemplateSys = `${RedisKeyStringsSys}${'' | `:${string}`}`;
export type RedisKeyTemplates = RedisKeyTemplateCache | RedisKeyTemplateSys;

// @redis/client/dist/lib
type RedisCommandArgument = string | Buffer;
interface QueueCommandOptions {
  asap?: boolean;
  chainId?: symbol;
  signal?: AbortSignal;
  returnBuffers?: boolean;
}
interface ClientCommandOptions extends QueueCommandOptions {
  isolated?: boolean;
}
// declare const symbol: unique symbol;
// type CommandOptions<T> = T & {
//   readonly [symbol]: true;
// };
// type CommandType = CommandOptions<ClientCommandOptions>;
type CommandType = ClientCommandOptions;

interface CustomRedisClient<K extends RedisKeyTemplates>
  extends Omit<
    RedisClientType,
    | 'set'
    | 'get'
    | 'mGet'
    | 'mSet'
    | 'setNX'
    | 'sAdd'
    | 'sRem'
    | 'sPop'
    | 'sMembers'
    | 'hGet'
    | 'hGetAll'
    | 'hSet'
    | 'hmGet'
    | 'del'
    | 'exists'
    | 'expire'
    | 'expireAt'
    | 'hDel'
    | 'hExists'
    | 'hExpire'
    | 'hIncrBy'
    | 'hSetNX'
    | 'incrBy'
    | 'lLen'
    | 'lPopCount'
    | 'lPush'
    | 'lRange'
    | 'memoryUsage'
    | 'ttl'
    | 'type'
    | 'sCard'
  > {
  packed: {
    get<T>(key: K): Promise<T | null>;
    mGet<T>(keys: K[]): Promise<(T | null)[]>;
    set<T>(key: K, value: T, setOptions?: SetOptions): Promise<void>;
    mSet(records: Record<K, unknown>, setOptions?: SetOptions): Promise<void>;
    setNX<T>(key: K, value: T): Promise<void>;
    sAdd<T>(key: K, values: T[]): Promise<void>;
    sRemove<T>(key: K, value: T): Promise<void>;
    sPop<T>(key: K, count: number): Promise<T[]>;
    sMembers<T>(key: K): Promise<T[]>;
    hGet<T>(key: K, hashKey: string): Promise<T | null>;
    hGetAll<T>(key: K): Promise<{ [x: string]: T }>;
    hSet<T>(key: K, hashKey: string, value: T): Promise<void>;
    hmSet<T>(key: K, records: Record<string, T>): Promise<void>;
    hmGet<T>(key: K, hashKeys: string[]): Promise<(T | null)[]>;
  };
  // nb - some of these take various argument option types (like CommandType) that may need to be adjusted if we need them
  set<T = string>(
    ...args:
      | [key: K, value: T, setOptions?: SetOptions]
      | [options: CommandType, key: K, value: T, setOptions?: SetOptions]
  ): Promise<T | null>;
  get<T = string>(...args: [key: K] | [options: CommandType, key: K]): Promise<T | null>;
  mGet<T = string>(...args: [keys: K[]] | [options: CommandType, keys: K[]]): Promise<(T | null)[]>;
  mSet<T = string>(
    ...args:
      | [records: [K, RedisCommandArgument][] | K[] | Record<K, RedisCommandArgument>]
      | [
          options: CommandType,
          records: [K, RedisCommandArgument][] | K[] | Record<K, RedisCommandArgument>
        ]
  ): Promise<T>;
  setNX<T>(key: K, value: T): Promise<boolean>;
  sAdd<T>(key: K, values: T | T[]): Promise<number>;
  sRem<T>(key: K, values: T | T[]): Promise<number>;
  sPop<T = string>(
    ...args: [key: K, count: number] | [options: CommandType, key: K, count: number]
  ): Promise<T[]>;
  sMembers<T = string>(...args: [key: K] | [options: CommandType, key: K]): Promise<T[]>;
  hGet<T = string>(
    ...args:
      | [key: K, hashKey: RedisCommandArgument]
      | [options: CommandType, key: K, hashKey: RedisCommandArgument]
  ): Promise<T | null>;
  hGetAll<T = string>(
    ...args: [key: K] | [options: CommandType, key: K]
  ): Promise<{ [x: string]: T }>;
  hSet<T>(
    ...args:
      | [key: K, hashKey: RedisCommandArgument, value: T]
      | [key: K, value: T]
      | [options: CommandType, key: K, hashKey: RedisCommandArgument, value: T]
      | [options: CommandType, key: K, value: T]
  ): Promise<number>;
  hmGet<T = string>(
    ...args:
      | [key: K, hashKeys: RedisCommandArgument | RedisCommandArgument[]]
      | [options: CommandType, key: K, hashKeys: RedisCommandArgument | RedisCommandArgument[]]
  ): Promise<T[]>;
  del(key: K | K[]): Promise<number>;
  exists(key: K | K[]): Promise<number>;
  expire(key: K, seconds: number, mode?: 'NX' | 'XX' | 'GT' | 'LT'): Promise<boolean>;
  expireAt(key: K, timestamp: number | Date, mode?: 'NX' | 'XX' | 'GT' | 'LT'): Promise<boolean>;
  hDel(key: K, hashKey: RedisCommandArgument | RedisCommandArgument[]): Promise<number>;
  hExists(key: K, hashKey: RedisCommandArgument): Promise<boolean>;
  hExpire(
    key: K,
    fields: RedisCommandArgument | RedisCommandArgument[],
    seconds: number,
    mode?: 'NX' | 'XX' | 'GT' | 'LT'
  ): ReturnType<RedisClientType['hExpire']>;
  hIncrBy(key: K, hashKey: RedisCommandArgument, increment: number): Promise<number>;
  hSetNX(key: K, hashKey: RedisCommandArgument, value: RedisCommandArgument): Promise<boolean>;
  incrBy(key: K, increment: number): Promise<number>;
  lLen(key: K): Promise<number>;
  lPopCount<T = string>(key: K, count: number): Promise<T[] | null>;
  lPush(key: K, values: RedisCommandArgument | RedisCommandArgument[]): Promise<number>;
  lRange<T = string>(key: K, start: number, stop: number): Promise<T[]>;
  memoryUsage(key: K, options?: { SAMPLES?: number }): Promise<number | null>;
  sCard(key: K): Promise<number>;
  ttl(key: K): Promise<number>;
  type(key: K): Promise<string>;
  setNxKeepTtlWithEx(key: K, value: string, ttl: number): Promise<boolean>;
}

interface CustomRedisClientCache extends CustomRedisClient<RedisKeyTemplateCache> {
  purgeTags: (tag: string | string[]) => Promise<void>;
}
// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface CustomRedisClientSys extends CustomRedisClient<RedisKeyTemplateSys> {}

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var globalRedis: CustomRedisClientCache | undefined;
  // eslint-disable-next-line no-var, vars-on-top
  var globalSysRedis: CustomRedisClientSys | undefined;
}

const log = createLogger('redis', 'green');

function getBaseClient(type: 'cache' | 'system', legacyMode = false) {
  log(`Creating Redis client (${type})`);

  const REDIS_URL = type === 'system' ? env.REDIS_SYS_URL : env.REDIS_URL;

  const baseClient = createClient({
    url: REDIS_URL,
    socket: {
      reconnectStrategy(retries) {
        log(`Redis reconnecting, retry ${retries}`);
        return Math.min(retries * 100, 3000);
      },
      connectTimeout: env.REDIS_TIMEOUT,
    },
    legacyMode,
    pingInterval: 4 * 60 * 1000,
    disableClientInfo: true, // this is for twemproxy, DONT REMOVE
  });
  baseClient.on('error', (err) => log(`Redis Error: ${err}`));
  baseClient.on('connect', () => log('Redis connected'));
  baseClient.on('reconnecting', () => log('Redis reconnecting'));
  baseClient.on('ready', () => log('Redis ready!'));
  // TODO should connect be here? it won't be ready yet, and is not awaited
  baseClient.connect();

  return baseClient;
}

function getClient<K extends RedisKeyTemplates>(type: 'cache' | 'system', legacyMode = false) {
  const client = getBaseClient(type, legacyMode) as unknown as CustomRedisClient<K>;

  client.packed = {
    async get<T>(key: K): Promise<T | null> {
      const result = await client.get<Buffer>(commandOptions({ returnBuffers: true }), key);
      return result ? unpack(result) : null;
    },

    async mGet<T>(keys: K[]): Promise<(T | null)[]> {
      const results = await client.mGet<Buffer>(commandOptions({ returnBuffers: true }), keys);
      return results.map((result) => (result ? unpack(result) : null));
    },

    // TODO can i get rid of types?
    // async set(key, value, options) {
    async set<T>(key: K, value: T, options?: SetOptions): Promise<void> {
      await client.set(key, pack(value), options);
    },

    async mSet(records: Record<K, unknown>): Promise<void> {
      const packedRecords: [K, Buffer][] = Object.entries(records).map(([k, v]) => [
        k as K,
        pack(v),
      ]);
      await client.mSet(packedRecords);
    },

    async setNX<T>(key: K, value: T): Promise<void> {
      await client.setNX(key, pack(value));
    },

    async sAdd<T>(key: K, values: T[]): Promise<void> {
      await client.sAdd(key, values.map(pack));
    },

    async sPop<T>(key: K, count: number): Promise<T[]> {
      const packedValues = await client.sPop<Buffer>(
        commandOptions({ returnBuffers: true }),
        key,
        count
      );
      return packedValues.map((value) => unpack(value));
    },

    async sRemove<T>(key: K, value: T): Promise<void> {
      await client.sRem(key, pack(value));
    },

    async sMembers<T>(key: K): Promise<T[]> {
      const packedValues = await client.sMembers<Buffer>(
        commandOptions({ returnBuffers: true }),
        key
      );
      return packedValues.map((value) => unpack(value));
    },

    async hGet<T>(key: K, hashKey: string): Promise<T | null> {
      const result = await client.hGet<Buffer>(
        commandOptions({ returnBuffers: true }),
        key,
        hashKey
      );
      return result ? unpack(result) : null;
    },

    async hGetAll<T>(key: K): Promise<{ [x: string]: T }> {
      const results = await client.hGetAll<Buffer>(commandOptions({ returnBuffers: true }), key);
      return Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v ? unpack(v) : null]));
    },

    async hSet<T>(key: K, hashKey: string, value: T): Promise<void> {
      await client.hSet(key, hashKey, pack(value));
    },

    async hmSet<T>(key: K, records: Record<string, T>): Promise<void> {
      const packedRecords: Record<string, Buffer> = {};
      for (const [hashKey, value] of Object.entries(records)) {
        packedRecords[hashKey] = pack(value);
      }
      await client.hSet(key, packedRecords);
    },

    async hmGet<T>(key: K, hashKeys: string[]): Promise<(T | null)[]> {
      const results = await client.hmGet<Buffer>(
        commandOptions({ returnBuffers: true }),
        key,
        hashKeys
      );
      return results.map((result) => (result ? unpack(result) : null));
    },
  };

  client.setNxKeepTtlWithEx = async (key, value, ttl) => {
    const script: string = `
      if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'KEEPTTL') then
          return redis.call('EXPIRE', KEYS[1], ARGV[2])
      else
          return 0
      end
    `;
    const result = await client.eval(script, {
      keys: [key],
      arguments: [value, ttl.toString()],
    });
    return result === 1; // 1 if set, 0 if not set
  };

  return client;
}

function getCacheClient(legacyMode = false) {
  const client = getClient<RedisKeyTemplateCache>('cache', legacyMode) as CustomRedisClientCache;

  client.purgeTags = async (tag: string | string[]) => {
    const tags = Array.isArray(tag) ? tag : [tag];
    for (const tag of tags) {
      const cacheKey = `${REDIS_KEYS.CACHES.TAGGED_CACHE}:${slugit(tag)}` as const;
      const count = await client.sCard(cacheKey);
      let processed = 0;
      while (true) {
        const keys: RedisKeyTemplateCache[] = await client.sPop(cacheKey, 1000);
        const hasOverfetched = processed > count * 1.5;
        if (!keys.length || hasOverfetched) break;
        await client.del(keys);
        processed += keys.length;
      }
    }
  };

  return client;
}

function getSysClient(legacyMode = false) {
  return getClient<RedisKeyTemplateSys>('system', legacyMode) as CustomRedisClientSys;
}

export let redis: CustomRedisClientCache;
if (isProd) {
  redis = getCacheClient();
} else {
  if (!global.globalRedis) global.globalRedis = getCacheClient();
  redis = global.globalRedis;
}

export let sysRedis: CustomRedisClientSys;
if (isProd) {
  sysRedis = getSysClient();
} else {
  if (!global.globalSysRedis) global.globalSysRedis = getSysClient();
  sysRedis = global.globalSysRedis;
}

// Source of Truth data
export const REDIS_SYS_KEYS = {
  DOWNLOAD: {
    LIMITS: 'download:limits',
    HISTORY_EXCLUSION: 'download:history-exclusion',
  },
  GENERATION: {
    LIMITS: 'generation:limits',
    STATUS: 'generation:status',
    WORKFLOWS: 'generation:workflows',
    ENGINES: 'generation:engines',
    TOKENS: 'generation:tokens',
  },
  TRAINING: {
    STATUS: 'training:status',
  },
  CLIENT: 'client',
  SYSTEM: {
    FEATURES: 'system:features',
    PERMISSIONS: 'system:permissions',
    USER_SCORE_MULTIPLIERS: 'system:user-score-multipliers',
    NON_CRITICAL_HEALTHCHECKS: 'non-critical-healthchecks',
    DISABLED_HEALTHCHECKS: 'disabled-healthchecks',
    FEATURE_STATUS: 'system:feature-status',
  },
  INDEX_UPDATES: {
    IMAGE_METRIC: 'index-updates:image-metric',
  },
  QUEUES: {
    BUCKETS: 'queues:buckets',
    SEEN_IMAGES: 'queues:seen-images',
  },
  RESEARCH: {
    RATINGS_TRACKS: 'research:ratings-tracks-2',
    RATINGS_SANITY_IDS: 'research:ratings-sanity-ids',
  },
  LIMITS: {
    EMAIL_VERIFICATIONS: 'limits:email-verifications',
    HISTORY_DOWNLOADS: 'limits:history-downloads',
  },
  INDEXES: {
    IMAGE_DELETED: 'indexes:image-deleted',
  },
  DAILY_CHALLENGE: {
    CONFIG: 'daily-challenge:config',
  },
  EVENT: 'event', // special case
  SESSION: {
    ALL: 'session:all',
    INVALID_TOKENS: 'session:invalid-tokens',
  },
  JOB: 'job',
  BUZZ_WITHDRAWAL_REQUEST: {
    STATUS: 'buzz-withdrawal-request:status',
  },
} as const;

// Cached data
export const REDIS_KEYS = {
  DOWNLOAD: {
    COUNT: 'download:count',
  },
  USER: {
    BASE: 'user',
    SESSION: 'session:data2',
    CACHE: 'packed:user',
  },
  SESSION: {
    BASE: 'session',
  },
  BUZZ_EVENTS: 'buzz-events',
  GENERATION: {
    RESOURCE_DATA: 'packed:generation:resource-data',
    TOKENS: 'generation:tokens',
    COUNT: 'generation:count',
  },
  SYSTEM: {
    MODERATED_TAGS: 'packed:system:moderated_tags',
    TAG_RULES: 'system:tag-rules',
    SYSTEM_TAGS: 'system:tags',
    TAGS_NEEDING_REVIEW: 'system:tags-needing-review',
    TAGS_BLOCKED: 'system:tags-blocked',
    HOME_EXCLUDED_TAGS: 'system:home-excluded-tags',
    BLOCKLIST: 'system:blocklist',
    NOTIFICATION_COUNTS: 'system:notification-counts',
    CATEGORIES: 'system:categories',
  },
  CACHES: {
    FILES_FOR_MODEL_VERSION: 'packed:caches:files-for-model-version',
    MULTIPLIERS_FOR_USER: 'packed:caches:multipliers-for-user',
    TAG_IDS_FOR_IMAGES: 'packed:caches:tag-ids-for-images',
    USER_COSMETICS: 'packed:caches:user-cosmetics',
    COSMETICS_OLD: 'packed:caches:cosmetics',
    COSMETICS: 'packed:caches:cosmetics2',
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
    FEATURED_MODELS: 'packed:featured-models2',
    IMAGE_META: 'packed:caches:image-meta',
    IMAGE_METADATA: 'packed:caches:image-metadata',
    ANNOUNCEMENTS: 'packed:caches:announcement',
    THUMBNAILS: 'packed:caches:thumbnails',
  },
  RESEARCH: {
    RATINGS_COUNT: 'research:ratings-count',
    RATINGS_PROGRESS: 'research:ratings-progress',
  },
  COUNTERS: {
    REDEMPTION_ATTEMPTS: 'counters:redemption-attempts',
    EMAIL_VERIFICATIONS: 'counters:email-verifications',
    HISTORY_DOWNLOADS: 'counters:history-downloads',
  },
  LIVE_NOW: 'live-now',
  DAILY_CHALLENGE: {
    DETAILS: 'daily-challenge:details',
  },
  TAG: 'tag',
  EVENT: {
    BASE: 'event', // special case
    EVENT_CLEANUP: 'eventCleanup',
    CACHE: 'packed:event',
  },
  COSMETICS: {
    IDS: 'cosmeticIds',
  },
  TRPC: {
    BASE: 'packed:trpc',
    LIMIT: {
      BASE: 'packed:trpc:limit',
      KEYS: 'packed:trpc:limit:keys',
    },
  },
  MODEL: {
    GALLERY_SETTINGS: 'model:gallery-settings',
  },
  LAG_HELPER: 'lag-helper',
  HOLIDAY: {
    '2023': {
      BASE: 'holiday2023',
      CACHE: 'packed:holiday2023',
    },
    '2024': {
      BASE: 'holiday2024',
      CACHE: 'packed:holiday2024',
    },
  },
  BEEHIIV: {
    NEWSLETTER: 'newsletter',
  },
  HOMEBLOCKS: {
    BASE: 'packed:home-blocks',
  },
  CACHE_LOCKS: 'cache-lock',
  BUZZ: {
    POTENTIAL_POOL: 'buzz:potential-pool',
    POTENTIAL_POOL_VALUE: 'buzz:potential-pool-value',
    EARNED: 'buzz:earned',
  },
} as const;

// These are used as subkeys after a dynamic key, such as `user:13:stuff`
// we should probably be flipping all redis keys to have any dynamic keys come at the end
export const REDIS_SUB_KEYS = {
  USER: {
    MODEL_ENGAGEMENTS: 'model-engagements', // cache
    PRIVATE_ENTITY_ACCESS: 'private-entity-access', // cache
  },
  EVENT: {
    COSMETICS: 'cosmetics', // cache
    CONTRIBUTORS: 'contributors', // sys
    PARTNERS: 'partners', // sys
    ADD_ROLE: 'add-role', // sys
    MANUAL_ASSIGNMENTS: 'manual-assignments', //sys
    DISCORD_ROLES: 'discord-roles', // sys
  },
  QUEUES: {
    MERGING: 'merging', // sys
  },
} as const;
