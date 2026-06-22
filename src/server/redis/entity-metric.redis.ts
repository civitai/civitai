import type {
  EntityMetric_EntityType_Type,
  EntityMetric_MetricType_Type,
} from '~/shared/utils/prisma/enums';
import { chunk } from 'lodash-es';
import type { RedisKeyTemplateCache } from './client';
import { redis, REDIS_KEYS } from './client';
import { createLogger } from '~/utils/logging';
import { withMetricWriteFailSoft } from '~/server/redis/metric-write-failsoft';

const log = createLogger('entity-metrics-redis', 'blue');

// FIX #3: fail-soft hook for the increment WRITE path. Engagement-count increments are
// analytics only (never money/entitlement), so a wedged cluster client must not 500/park a
// user mutation through them — skip the increment, log + count, let the action succeed.
function metricWriteFailHook(op: string, err: unknown) {
  log(`metric write fail-soft [op=${op}]:`, err instanceof Error ? err.message : err);
  (
    globalThis as unknown as {
      __civitaiRedisMetrics?: {
        redisMetricWriteFailSoftCounter?: { labels: (l: { op: string }) => { inc: () => void } };
      };
    }
  ).__civitaiRedisMetrics?.redisMetricWriteFailSoftCounter?.labels({ op }).inc();
}

/**
 * Static helper methods for entity metrics calculations
 * Avoids object creation overhead for bulk operations
 */
export class EntityMetricsHelper {
  // Calculate total engagement (all metrics except Buzz)
  static getTotalEngagement(metrics: Record<string, number>): number {
    return (
      (metrics.ReactionLike || 0) +
      (metrics.ReactionHeart || 0) +
      (metrics.ReactionLaugh || 0) +
      (metrics.ReactionCry || 0) +
      (metrics.Comment || 0) +
      (metrics.Collection || 0)
    );
  }

  // Calculate total reactions only
  static getTotalReactions(metrics: Record<string, number>): number {
    return (
      (metrics.ReactionLike || 0) +
      (metrics.ReactionHeart || 0) +
      (metrics.ReactionLaugh || 0) +
      (metrics.ReactionCry || 0)
    );
  }

  // Calculate total including buzz
  static getTotal(metrics: Record<string, number>): number {
    return this.getTotalEngagement(metrics) + (metrics.Buzz || 0);
  }

  // Custom sum with filter
  static sum(metrics: Record<string, number>, filter?: (metricType: string) => boolean): number {
    return Object.entries(metrics)
      .filter(([key]) => !filter || filter(key))
      .reduce((sum, [, value]) => sum + value, 0);
  }
}

export class EntityMetricRedisClient {
  private redis: typeof redis;

  constructor(redisClient: typeof redis) {
    this.redis = redisClient;
  }

  private getKey(entityType: string, entityId: number): RedisKeyTemplateCache {
    return `${REDIS_KEYS.ENTITY_METRICS.BASE}:${entityType}:${entityId}` as RedisKeyTemplateCache;
  }

  async increment(
    entityType: EntityMetric_EntityType_Type,
    entityId: number,
    metricType: EntityMetric_MetricType_Type,
    amount = 1
  ): Promise<number> {
    const key = this.getKey(entityType, entityId);
    // FIX #3: fail-fast (short timeout) + fail-soft (skip on wedge → return 0) so a wedged
    // cluster client can't 500/park the user mutation that triggered this analytics
    // increment. 0 means "couldn't read the new total" — the only consumer is the < 0
    // negative-correction in metric-helpers.ts, which 0 safely skips.
    const result = await withMetricWriteFailSoft(
      () => this.redis.hIncrBy(key, metricType, amount),
      0,
      { op: 'increment:hIncrBy', onFail: metricWriteFailHook }
    );
    // Bound the key on the hot increment path too. setMetric/setMultipleMetrics
    // set this TTL, but increment() previously left the key permanent — so any
    // entitymetric:* key whose first/only touch was an increment (the hot
    // reaction/comment path) never expired. Refreshing on each increment also
    // gives a sliding TTL: the key lives while active, reaped 1h after the last
    // touch. (2026-06-09 redis usage audit)
    await withMetricWriteFailSoft(
      () => this.redis.expire(key, EntityMetricRedisClient.METRIC_TTL_SECONDS),
      false,
      { op: 'increment:expire', onFail: metricWriteFailHook }
    );
    return result;
  }

  async getMetric(
    entityType: EntityMetric_EntityType_Type,
    entityId: number,
    metricType: EntityMetric_MetricType_Type
  ): Promise<number> {
    const key = this.getKey(entityType, entityId);
    const value = await this.redis.hGet<string>(key, metricType);
    return value ? parseInt(value, 10) : 0;
  }

  async getAllMetrics(
    entityType: EntityMetric_EntityType_Type,
    entityId: number
  ): Promise<Record<string, number>> {
    const key = this.getKey(entityType, entityId);
    const metrics = await this.redis.hGetAll<string>(key);

    // Convert string values to numbers
    const result: Record<string, number> = {};
    for (const [metricType, value] of Object.entries(metrics)) {
      result[metricType] = parseInt(value as string, 10) || 0;
    }
    return result;
  }

  async getBulkMetrics(
    entityType: EntityMetric_EntityType_Type,
    entityIds: number[]
  ): Promise<Map<number, Record<string, number>>> {
    const metricsMap = new Map<number, Record<string, number>>();

    if (entityIds.length === 0) {
      return metricsMap;
    }

    // Process in batches to avoid overwhelming Redis
    const batches = chunk(entityIds, 100);

    for (const batch of batches) {
      // Use mGet for better performance with multiple keys
      const keys = batch.map((id) => this.getKey(entityType, id));

      // Fetch all hashes in parallel
      const promises = keys.map((key) => this.redis.hGetAll<string>(key));
      const results = await Promise.all(promises);

      for (let i = 0; i < batch.length; i++) {
        const metrics = results[i];
        const numericMetrics: Record<string, number> = {};

        if (metrics && Object.keys(metrics).length > 0) {
          for (const [k, v] of Object.entries(metrics)) {
            numericMetrics[k] = parseInt(v as string, 10) || 0;
          }
        }

        metricsMap.set(batch[i], numericMetrics);
      }
    }

    return metricsMap;
  }

  // TTL for entity metric keys (1 hour). Metrics are repopulated from ClickHouse
  // on cache miss, so short TTL is safe. Without TTL, keys are permanent and
  // accumulate to ~7M keys/shard (~0.8 GiB), contributing to Redis OOM at scale.
  private static readonly METRIC_TTL_SECONDS = 3600;

  async setMetric(
    entityType: EntityMetric_EntityType_Type,
    entityId: number,
    metricType: EntityMetric_MetricType_Type,
    value: number
  ): Promise<void> {
    const key = this.getKey(entityType, entityId);
    await this.redis.hSet(key, metricType, value.toString());
    await this.redis.expire(key, EntityMetricRedisClient.METRIC_TTL_SECONDS);
  }

  async setMultipleMetrics(
    entityType: EntityMetric_EntityType_Type,
    entityId: number,
    metrics: Record<EntityMetric_MetricType_Type, number>
  ): Promise<void> {
    if (Object.keys(metrics).length === 0) return; // no-op if no metrics provided

    const key = this.getKey(entityType, entityId);
    await this.redis.hSet(key, metrics);
    await this.redis.expire(key, EntityMetricRedisClient.METRIC_TTL_SECONDS);
  }

  async exists(entityType: EntityMetric_EntityType_Type, entityId: number): Promise<boolean> {
    const key = this.getKey(entityType, entityId);
    const exists = await this.redis.exists(key);
    return exists > 0;
  }

  async delete(entityType: EntityMetric_EntityType_Type, entityId: number): Promise<boolean> {
    const key = this.getKey(entityType, entityId);
    const deleted = await this.redis.del(key);
    return deleted > 0;
  }

  async setTTL(
    entityType: EntityMetric_EntityType_Type,
    entityId: number,
    seconds: number
  ): Promise<boolean> {
    const key = this.getKey(entityType, entityId);
    return await this.redis.expire(key, seconds);
  }
}

// Export singleton instance
export const entityMetricRedis = new EntityMetricRedisClient(redis);
