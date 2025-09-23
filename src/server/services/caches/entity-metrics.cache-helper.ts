import { entityMetricRedis } from '~/server/redis/entity-metric.redis';
import { populateEntityMetrics } from '~/server/redis/entity-metric-populate';
import type { CachedObject } from '~/server/utils/cache-helpers';

/**
 * Valid entity types for metrics caching
 */
export type EntityType = 'Image' | 'Post' | 'Model' | 'ModelVersion' | 'Collection' | 'User';

/**
 * Raw metrics map from Redis
 */
export type RawMetricsMap = Map<number, Record<string, number>>;

/**
 * Configuration for metric transformation
 */
export interface MetricTransformConfig<T> {
  entityType: EntityType;
  transformMetrics: (entityId: number, metrics: Record<string, number> | undefined) => T;
  additionalDataFetcher?: (ids: number[]) => Promise<Map<number, any>>;
}

/**
 * Creates a standardized entity metrics cache with the CachedObject interface
 *
 * @param config Configuration for the specific entity type and transformations
 * @returns Cache object with fetch, bust, refresh, flush methods
 */
export function createEntityMetricsCache<T extends { [key: string]: any }>(
  config: MetricTransformConfig<T>
): Pick<CachedObject<T>, 'fetch' | 'bust' | 'refresh' | 'flush'> {
  const { entityType, transformMetrics, additionalDataFetcher } = config;

  return {
    fetch: async (ids: number | number[]): Promise<Record<string, T>> => {
      // Normalize input
      if (!Array.isArray(ids)) ids = [ids];
      if (ids.length === 0) return {};

      // Populate missing metrics from ClickHouse (uses per-ID locks internally)
      await populateEntityMetrics(entityType, ids);

      // Fetch base metrics from Redis
      const metricsMap = await entityMetricRedis.getBulkMetrics(entityType, ids);

      // Fetch additional data if needed
      let additionalData: Map<number, any> | undefined;
      if (additionalDataFetcher) {
        additionalData = await additionalDataFetcher(ids);
      }

      // Transform metrics for each entity
      const results: Record<string, T> = {};
      for (const id of ids) {
        const rawMetrics = metricsMap.get(id);
        const extra = additionalData?.get(id);

        // Apply transformation with additional data if available
        results[id] = transformMetrics(id, rawMetrics);

        // Merge additional data if provided
        if (extra && typeof results[id] === 'object') {
          Object.assign(results[id], extra);
        }
      }

      return results;
    },

    bust: async (ids: number | number[]) => {
      // Normalize input
      if (!Array.isArray(ids)) ids = [ids];
      if (ids.length === 0) return;

      // Delete from Redis to force re-fetch from ClickHouse
      await Promise.all(ids.map((id) => entityMetricRedis.delete(entityType, id)));
    },

    refresh: async (ids: number | number[], skipCache?: boolean) => {
      // Normalize input
      if (!Array.isArray(ids)) ids = [ids];
      if (ids.length === 0) return;

      // Force refresh from ClickHouse with forceRefresh=true to overwrite existing values
      await populateEntityMetrics(entityType, ids, true);
    },

    flush: async () => {
      // Clear all metrics from Redis for this entity type - Not Supported
      // This would require iterating through all keys which is expensive
    },
  };
}

/**
 * Helper function to safely get metric value or null
 */
export function getMetricValue(
  metrics: Record<string, number> | undefined,
  key: string
): number | null {
  return metrics?.[key] || null;
}

/**
 * Helper function to calculate sum of multiple metrics
 */
export function sumMetrics(
  metrics: Record<string, number> | undefined,
  keys: string[]
): number | null {
  if (!metrics) return null;

  const sum = keys.reduce((total, key) => total + (metrics[key] || 0), 0);
  return sum || null;
}

/**
 * Helper function to calculate rating from thumbs up/down
 */
export function calculateRating(metrics: Record<string, number> | undefined): {
  rating: number | null;
  ratingCount: number | null;
} {
  if (!metrics) return { rating: null, ratingCount: null };

  const thumbsUp = metrics.ThumbsUp || 0;
  const thumbsDown = metrics.ThumbsDown || 0;
  const ratingCount = thumbsUp + thumbsDown;
  const rating = ratingCount > 0 ? (thumbsUp / ratingCount) * 5 : null;

  return {
    rating,
    ratingCount: ratingCount || null,
  };
}
