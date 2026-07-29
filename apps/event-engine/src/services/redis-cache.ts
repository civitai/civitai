import { createCluster, RedisClusterType } from 'redis'
import { CacheUpdate, MetricEvent } from '@/types/events'
import { logger } from '@/utils/logger'
import { cacheKeys } from '@/common/utils/cache-keys'
import { EntityType } from '@/common/types/metric-types'
import { RedisWithHelpers, withRedisHelpers } from '@/common/utils/query-utils'
import { chunk } from '@/common/utils/basic'
import { redisCacheMetrics } from '@/metrics'
import { config } from '@/config'

/**
 * Manages Redis cache updates for real-time metrics
 */
export class RedisCache {
  private client: RedisWithHelpers<RedisClusterType> | null = null
  private isConnected: boolean = false

  constructor(private redisUrl: string) {}

  /**
   * Connect to Redis
   */
  async connect(): Promise<void> {
    if (this.isConnected) return

    try {
      const url = new URL(this.redisUrl);
      const redis: RedisClusterType = createCluster({
        rootNodes: [{url: `${url.protocol}//${url.host}`}],
        defaults: {
          username: url.username === '' ? undefined : url.username,
          password: url.password
        }
      })
      this.client = withRedisHelpers(redis)

      this.client.on('error', (err) => {
        logger.error({ err }, 'Redis Client Error')
      })

      await this.client.connect()
      this.isConnected = true
      await this.client.loadScripts();

      logger.info('Connected to Redis')
    } catch (err) {
      logger.error({ err }, 'Failed to connect to Redis')
      throw err
    }
  }

  /**
   * Disconnect from Redis
   */
  async disconnect(): Promise<void> {
    if (this.client && this.isConnected) {
      await this.client.quit()
      this.isConnected = false
      logger.info('Disconnected from Redis')
    }
  }

  /**
   * Get the Redis client instance
   */
  async getClient(): Promise<RedisWithHelpers<RedisClusterType>> {
    if (!this.client || !this.isConnected) {
      await this.connect()
    }
    return this.client!
  }

  /**
   * Increment a metric in the cache
   */
  async increment(update: CacheUpdate | CacheUpdate[]): Promise<void> {
    if (!config.redis.cacheUpdatesEnabled) return

    if (!this.client || !this.isConnected) {
      await this.connect()
    }

    update = Array.isArray(update) ? update : [update]

    // Use a pipeline for batch updates
    const batches = chunk(update, 1000); // Process in batches of 1000
    for (const batch of batches) {
      // Using concurrent commands (node redis pipelines)
      try {
        await this.client!.run(batch.map((upd) => {
          const key = this.buildCacheKey(upd.entityType, upd.entityId)
          return this.client!.hIncrIfExists(key, upd.metricType, upd.metricValue)
        }));
        redisCacheMetrics.cacheUpdates.inc({ operation: 'increment' }, batch.length)
      } catch (err) {
        logger.error({ err }, 'Failed to increment cache')
        redisCacheMetrics.cacheErrors.inc({ operation: 'increment' })
        // Don't throw - cache updates shouldn't break processing
      }
    }
  }

  /**
   * Idempotently increment a single metric event in the cache.
   *
   * Unlike increment(), a redelivered event (Kafka rebalance/retry) re-applying
   * the same delta is a no-op, so the cache can't drift upward from at-least-once
   * delivery. This is what lets the caller apply the increment inline as events
   * are processed, rather than deferring it until after the batch is durably
   * committed. Best-effort: failures are logged, never thrown.
   */
  async incrementOnce(
    event: MetricEvent,
    ttlSeconds: number = config.redis.cacheDedupeTtlSeconds,
  ): Promise<void> {
    if (!config.redis.cacheUpdatesEnabled) return
    if (event.entityId == null) return

    if (!this.client || !this.isConnected) {
      await this.connect()
    }

    const metricKey = this.buildCacheKey(event.entityType, event.entityId)

    // Dedupe on the SAME tuple ClickHouse's entityMetricEvents ReplacingMergeTree
    // dedups on — (entityType, entityId, metricType, userId, createdAt) — so the
    // cache and CH collapse duplicates identically and can't diverge. createdAt
    // is the deterministic Debezium source.ts_ms (see deriveEventTimestamp), so a
    // redelivery reproduces the exact same key; userId is always set (guarded in
    // addMetricEvent). entityType+entityId are already in metricKey.
    // Hash-tag with the metric key so the marker co-locates on the same cluster
    // slot (the Lua script touches both keys).
    const dedupeKey = `{${metricKey}}:dd:${event.metricType}:${event.userId ?? 0}:${+(event.timestamp ?? 0)}`

    try {
      await this.client!.hIncrIfExistsOnce(
        metricKey,
        dedupeKey,
        event.metricType,
        event.metricValue ?? 0,
        ttlSeconds,
      )
      redisCacheMetrics.cacheUpdates.inc({ operation: 'increment_once' })
    } catch (err) {
      logger.error({ err }, 'Failed to increment cache (once)')
      redisCacheMetrics.cacheErrors.inc({ operation: 'increment_once' })
    }
  }

  /**
   * Get metrics from cache
   */
  async getMetrics(
    entityType: string,
    entityId: number,
    metricTypes?: string[]
  ): Promise<Record<string, number>> {
    if (!this.client || !this.isConnected) {
      await this.connect()
    }

    const key = this.buildCacheKey(entityType, entityId)

    try {
      if (metricTypes && metricTypes.length > 0) {
        // Get specific fields
        const values = await this.client!.hmGet(key, metricTypes)
        const result: Record<string, number> = {}

        metricTypes.forEach((type, index) => {
          result[type] = parseInt(values[index] || '0', 10)
        })

        return result
      } else {
        // Get all fields
        const hash = await this.client!.hGetAll(key)
        const result: Record<string, number> = {}

        for (const [field, value] of Object.entries(hash)) {
          result[field] = parseInt(value, 10)
        }

        return result
      }
    } catch (err) {
      logger.error({ err, entityType, entityId }, 'Failed to get metrics from cache')
      return {}
    }
  }

  /**
   * Set metrics in cache (overwrites existing values)
   */
  async setMetrics(
    entityType: string,
    entityId: number,
    metrics: Record<string, number>,
    ttl?: number
  ): Promise<void> {
    if (!config.redis.cacheUpdatesEnabled) return

    if (!this.client || !this.isConnected) {
      await this.connect()
    }

    const key = this.buildCacheKey(entityType, entityId)

    try {
      // Convert numbers to strings for Redis
      const fields: Record<string, string> = {}
      for (const [field, value] of Object.entries(metrics)) {
        fields[field] = value.toString()
      }

      await this.client!.hSet(key, fields)

      // Set TTL if provided
      if (ttl) {
        await this.client!.expire(key, ttl)
      }

      logger.debug(`Set metrics for ${key}`)
    } catch (err) {
      logger.error({ err, entityType, entityId }, 'Failed to set metrics in cache')
    }
  }

  /**
   * Delete metrics from cache
   */
  async deleteMetrics(entityType: string, entityId: number): Promise<void> {
    if (!config.redis.cacheUpdatesEnabled) return

    if (!this.client || !this.isConnected) {
      await this.connect()
    }

    const key = this.buildCacheKey(entityType, entityId)

    try {
      await this.client!.del(key)
      logger.debug(`Deleted cache key: ${key}`)
    } catch (err) {
      logger.error({ err, entityType, entityId }, 'Failed to delete metrics from cache')
    }
  }

  /**
   * Check if metrics exist in cache
   */
  async exists(entityType: string, entityId: number): Promise<boolean> {
    if (!this.client || !this.isConnected) {
      await this.connect()
    }

    const key = this.buildCacheKey(entityType, entityId)

    try {
      const exists = await this.client!.exists(key)
      return exists === 1
    } catch (err) {
      logger.error({ err, entityType, entityId }, 'Failed to check cache existence')
      return false
    }
  }

  /**
   * Build a cache key
   */
  private buildCacheKey(entityType: string, entityId: number): string {
    return cacheKeys.metric(entityType as EntityType, entityId)
  }
}