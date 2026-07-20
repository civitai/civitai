import * as caches from '../caches';
import { CacheContext } from '../caches/base';
import { IRedisClient, IDbClient, IClickhouseClient, IDataPacker } from '../types/package-stubs';
import { withRedisPacking } from '../utils/redis-packer';

/**
 * Service to manage all caches with typed access
 *
 * Provides a centralized way to access cache functions with automatic type inference
 * based on the cache name.
 */
export class CacheService {
  private context: CacheContext;

  constructor(
    redis: IRedisClient,
    pg: IDbClient,
    ch: IClickhouseClient,
    packer?: IDataPacker
  ) {
    this.context = {
      redis: packer ? withRedisPacking(redis, packer) : redis,
      pg: {
        query: async <T = any>(query: string, params?: any[]) => {
          const result = await pg.query(query, params);
          return result.rows as T[];
        },
      },
      ch: {
        query: async <T = any>(query: string, params?: any[]) => {
          const result = await ch.query({
            query: params ? query.replace(/\$(\d+)/g, (_, i) => String(params[parseInt(i) - 1])) : query,
            format: 'JSONEachRow',
          });
          return (await result.json()) as T[];
        },
      },
    };
  }

  /**
   * Fetch items from a cache by name
   * Type is automatically inferred from the cache name
   */
  async fetch<K extends keyof typeof caches>(
    name: K,
    ids: number[]
  ): Promise<Awaited<ReturnType<(typeof caches)[K]['fetch']>>> {
    const cache = caches[name];
    if (!cache) throw new Error(`Cache named '${name}' could not be found`);

    return cache.fetch(this.context, ids) as any;
  }

  /**
   * Bust (invalidate) cache entries by ID
   */
  async bust<K extends keyof typeof caches>(
    name: K,
    ids: number | number[],
    options?: { debounceTime?: number }
  ): Promise<void> {
    const cache = caches[name];
    if (!cache) throw new Error(`Cache named '${name}' could not be found`);

    return cache.bust(this.context, ids, options);
  }

  /**
   * Refresh cache entries by ID
   */
  async refresh<K extends keyof typeof caches>(name: K, ids: number | number[]): Promise<void> {
    const cache = caches[name];
    if (!cache) throw new Error(`Cache named '${name}' could not be found`);

    return cache.refresh(this.context, ids);
  }

  /**
   * Get multiple keys from Redis (batch get)
   * Provides direct access to Redis for feed operations
   */
  async mGet<T>(keys: string[]): Promise<(T | null)[]> {
    if (!this.context.redis.packed) throw new Error('Redis packed methods not available');
    return this.context.redis.packed.mGet<T>(keys);
  }

  /**
   * Set a key-value pair in Redis with optional expiration
   * Provides direct access to Redis for feed operations
   */
  async set<T>(key: string, value: T, options?: { EX?: number }): Promise<void> {
    if (!this.context.redis.packed) throw new Error('Redis packed methods not available');
    return this.context.redis.packed.set<T>(key, value, options);
  }

  /**
   * Add values to a Redis set
   * Provides direct access to Redis for feed operations
   */
  async sAdd<T>(key: string, values: T[]): Promise<void> {
    if (!this.context.redis.packed) throw new Error('Redis packed methods not available');
    return this.context.redis.packed.sAdd<T>(key, values);
  }
}
