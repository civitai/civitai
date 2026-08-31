import type {
  RedisCacheClient,
  RedisSysClient,
  RedisKeyTemplateCache,
  RedisKeyTemplateSys,
  RedisKeyTemplates,
} from './client';

// Read-through Redis cache for expensive reads (e.g. ClickHouse metrics) so a client reloading a page doesn't
// re-hit the source every time. Build ONE cache factory per app+client with `createRedisCacheBuilder` (cache
// client) or `createSysRedisCacheBuilder` (sys client), setting the app-wide key `prefix` once; then define one
// cache per data family with `createCache({ name, fetch, ttlSeconds })` and call `.get(args)` with named args.
//
// - **Args are the key.** The named args double as the cache key (sorted, so field order doesn't matter), so the
//   key can't drift out of sync with what's actually fetched (no separate key array to keep aligned).
// - **Named TTL.** `ttlSeconds` receives the same args object, so it can pick just the field(s) it needs by name
//   (e.g. `({ days }) => …`) without caring about the rest.
// - Values are JSON-packed via the client's `.packed` sub-client.
// - **Single-flight**: concurrent callers for the same key (e.g. a reload-burst on a just-expired key) share one
//   in-flight promise, so a cold key triggers exactly one fetch per instance instead of N. Matters most for slow
//   reads, where the in-flight window is seconds.
// - **TTL jitter**: the stored TTL gets a small +0–10% so keys created together don't expire in lockstep.
// - **Fail-open**: any Redis error (down, unconfigured) falls through to the fetcher, so caching can never break
//   a request — the worst case is an uncached read.
type KeyPart = string | number;
type CacheArgs = Record<string, KeyPart>;

export type Cache<Args extends CacheArgs, T> = {
  /** Read-through: return the cached value for these args, or run the fetcher, cache it, and return it. */
  get(args: Args): Promise<T>;
  /** Invalidate the entry for these args. */
  bust(args: Args): Promise<void>;
};

export type CacheDefinition<Args extends CacheArgs, T> = {
  /** Key segment identifying this data family, e.g. `analytics:content`. Combined with the builder prefix. */
  name: string;
  fetch: (args: Args) => Promise<T>;
  /** Seconds to cache; a function derives it from the args (e.g. a wider window caches longer). */
  ttlSeconds: number | ((args: Args) => number);
};

/** The slice of a redis client the cache needs — both the cache and sys clients satisfy it. */
type PackedClient<K extends RedisKeyTemplates> = {
  packed: {
    get<T>(key: K): Promise<T | null>;
    set<T>(key: K, value: T, setOptions?: { EX?: number }): Promise<unknown>;
  };
  del(key: K): Promise<unknown>;
};

/** A `createCache` bound to one app prefix + client. Its returned caches all live under `${prefix}:…`. */
export type CacheBuilder<K extends RedisKeyTemplates> = <Args extends CacheArgs, T>(
  definition: CacheDefinition<Args, T>
) => Cache<Args, T>;

function makeBuilder<K extends RedisKeyTemplates>(base: {
  getClient: () => PackedClient<K>;
  prefix: string;
}): CacheBuilder<K> {
  return function createCache<Args extends CacheArgs, T>(definition: CacheDefinition<Args, T>) {
    const { name, fetch, ttlSeconds } = definition;

    // Field names are sorted so a differently-ordered args object maps to the same key.
    const keyOf = (args: Args) => {
      const parts = Object.keys(args)
        .sort()
        .map((k) => `${k}:${args[k]}`)
        .join(':');
      return `${base.prefix}:${name}:${parts}` as unknown as K;
    };

    // Per-instance in-flight registry: coalesces concurrent misses for the same key into one fetch.
    const inflight = new Map<K, Promise<T>>();

    async function readThrough(key: K, args: Args): Promise<T> {
      try {
        const hit = await base.getClient().packed.get<T>(key);
        if (hit != null) return hit;
      } catch {
        /* redis miss/down → fall through to the source */
      }
      const value = await fetch(args);
      try {
        const ttl = typeof ttlSeconds === 'function' ? ttlSeconds(args) : ttlSeconds;
        const withJitter = ttl + Math.floor(Math.random() * ttl * 0.1); // +0–10% jitter
        await base.getClient().packed.set(key, value, { EX: withJitter });
      } catch {
        /* ignore write failure — the value is still returned */
      }
      return value;
    }

    return {
      async get(args: Args) {
        const key = keyOf(args);
        const existing = inflight.get(key);
        if (existing) return existing;

        const promise = readThrough(key, args);
        inflight.set(key, promise);
        try {
          return await promise;
        } finally {
          inflight.delete(key);
        }
      },

      async bust(args: Args) {
        try {
          await base.getClient().del(keyOf(args));
        } catch {
          /* ignore */
        }
      },
    };
  };
}

/**
 * Build a cache factory bound to the **cache** redis client and an app-wide key prefix.
 *
 *   const createCache = createRedisCacheBuilder({ getClient: getRedis, prefix: 'cs' });
 *   const getStats = createCache({ name: 'stats', fetch: ({ id }) => …, ttlSeconds: 300 }).get;
 *
 * `getClient` is a getter (not an instance) so the client can stay lazily constructed / build-safe.
 */
export function createRedisCacheBuilder(base: {
  getClient: () => RedisCacheClient;
  prefix: string;
}): CacheBuilder<RedisKeyTemplateCache> {
  return makeBuilder<RedisKeyTemplateCache>(base);
}

/** Same as `createRedisCacheBuilder`, bound to the **sys** redis client. */
export function createSysRedisCacheBuilder(base: {
  getClient: () => RedisSysClient;
  prefix: string;
}): CacheBuilder<RedisKeyTemplateSys> {
  return makeBuilder<RedisKeyTemplateSys>(base);
}
