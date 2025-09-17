import type {
  EntityMetric_EntityType_Type,
  EntityMetric_MetricType_Type,
} from '~/shared/utils/prisma/enums';
import { chunk } from 'lodash-es';
import type { RedisKeyTemplateCache } from './client';
import { redis, REDIS_KEYS } from './client';
import { createLogger } from '~/utils/logging';

const log = createLogger('entity-metrics-redis', 'blue');

/**
 * Static helper methods for entity metrics calculations
 * Avoids object creation overhead for bulk operations
 */
export class EntityMetricsHelper {
  // Calculate total engagement (all metrics except Buzz)
  static getTotalEngagement(metrics: Record<string, number>): number {
    return (metrics.ReactionLike || 0) +
           (metrics.ReactionHeart || 0) +
           (metrics.ReactionLaugh || 0) +
           (metrics.ReactionCry || 0) +
           (metrics.Comment || 0) +
           (metrics.Collection || 0);
  }

  // Calculate total reactions only
  static getTotalReactions(metrics: Record<string, number>): number {
    return (metrics.ReactionLike || 0) +
           (metrics.ReactionHeart || 0) +
           (metrics.ReactionLaugh || 0) +
           (metrics.ReactionCry || 0);
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
    amount: number = 1
  ): Promise<number> {
    const key = this.getKey(entityType, entityId);
    return await this.redis.hIncrBy(key, metricType, amount);
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
      const keys = batch.map(id => this.getKey(entityType, id));

      // Fetch all hashes in parallel
      const promises = keys.map(key => this.redis.hGetAll<string>(key));
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

  async setMetric(
    entityType: EntityMetric_EntityType_Type,
    entityId: number,
    metricType: EntityMetric_MetricType_Type,
    value: number
  ): Promise<void> {
    const key = this.getKey(entityType, entityId);
    await this.redis.hSet(key, metricType, value.toString());
  }

  async setMultipleMetrics(
    entityType: EntityMetric_EntityType_Type,
    entityId: number,
    metrics: Record<EntityMetric_MetricType_Type, number>
  ): Promise<void> {
    const key = this.getKey(entityType, entityId);

    // Build flat args array: [field1, value1, field2, value2, ...]
    const args = ['HMSET', key];
    for (const [metricType, value] of Object.entries(metrics)) {
      args.push(metricType, value.toString());
    }

    if (args.length === 0) return; // no-op if no metrics provided

    // Had to do it this way to satisfy twemproxy which doesn't support hSet with multiple fields
    await this.redis.sendCommand(args);
  }


  async exists(
    entityType: EntityMetric_EntityType_Type,
    entityId: number
  ): Promise<boolean> {
    const key = this.getKey(entityType, entityId);
    const exists = await this.redis.exists(key);
    return exists > 0;
  }

  async delete(
    entityType: EntityMetric_EntityType_Type,
    entityId: number
  ): Promise<boolean> {
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
