import { entityMetricRedis } from '~/server/redis/entity-metric.redis';
import { populateEntityMetrics } from '~/server/redis/entity-metric-populate';
import type { CachedObject } from '~/server/utils/cache-helpers';

export type ModelMetricLookup = {
  modelId: number;
  thumbsUpCount: number | null;
  thumbsDownCount: number | null;
  commentCount: number | null;
  collectionCount: number | null;
  tipCount: number | null;
  buzzAmount: number | null;
  downloadCount: number | null;
  generationCount: number | null;
  favoriteCount: number | null;
  imageCount: number | null;
  earnedAmount: number | null;
  rating: number | null;
  ratingCount: number | null;
};

export type ModelVersionMetricLookup = {
  modelVersionId: number;
  thumbsUpCount: number | null;
  thumbsDownCount: number | null;
  commentCount: number | null;
  downloadCount: number | null;
  generationCount: number | null;
  favoriteCount: number | null;
  imageCount: number | null;
  earnedAmount: number | null;
  rating: number | null;
  ratingCount: number | null;
};

// @dev: We'll need population functions for earnedAmount, generationCount, and downloadCount (as also requested in src/server/clickhouse/client.ts).
/**
 * Model metrics cache using direct Redis entity metrics
 * Follows the same pattern as imageMetricsCache
 */
export const modelMetricsCache: Pick<
  CachedObject<ModelMetricLookup>,
  'fetch' | 'bust' | 'refresh' | 'flush'
> = {
  fetch: async (ids: number | number[]): Promise<Record<string, ModelMetricLookup>> => {
    if (!Array.isArray(ids)) ids = [ids];
    if (ids.length === 0) return {};

    // Populate missing metrics from ClickHouse (uses per-ID locks internally)
    await populateEntityMetrics('Model', ids);

    // Fetch from Redis
    const metricsMap = await entityMetricRedis.getBulkMetrics('Model', ids);

    const results: Record<string, ModelMetricLookup> = {};
    for (const id of ids) {
      const metrics = metricsMap.get(id);

      // Calculate rating from thumbs up/down
      const thumbsUp = metrics?.ThumbsUp || 0;
      const thumbsDown = metrics?.ThumbsDown || 0;
      const ratingCount = thumbsUp + thumbsDown;
      const rating = ratingCount > 0 ? (thumbsUp / ratingCount) * 5 : null;

      results[id] = {
        modelId: id,
        thumbsUpCount: metrics?.ThumbsUp || null,
        thumbsDownCount: metrics?.ThumbsDown || null,
        commentCount: metrics?.Comment || null,
        collectionCount: metrics?.Collection || null,
        tipCount: metrics?.Tip || null,
        buzzAmount: metrics?.Buzz || null,
        downloadCount: metrics?.Download || null,
        generationCount: metrics?.Generation || null,
        favoriteCount: metrics?.Favorite || null,
        imageCount: metrics?.Image || null,
        earnedAmount: metrics?.Earned || null,
        rating,
        ratingCount: ratingCount || null,
      };
    }
    return results;
  },

  bust: async (ids: number | number[]) => {
    if (!Array.isArray(ids)) ids = [ids];
    if (ids.length === 0) return;

    // Delete from Redis to force re-fetch from ClickHouse
    await Promise.all(ids.map((id) => entityMetricRedis.delete('Model', id)));
  },

  refresh: async (ids: number | number[], skipCache?: boolean) => {
    if (!Array.isArray(ids)) ids = [ids];
    if (ids.length === 0) return;

    // Force refresh from ClickHouse with forceRefresh=true to overwrite existing values
    await populateEntityMetrics('Model', ids, true);
  },

  flush: async () => {
    // Clear all model metrics from Redis - Not Supported
  },
};

/**
 * Model Version metrics cache using direct Redis entity metrics
 * Follows the same pattern as imageMetricsCache
 */
export const modelVersionMetricsCache: Pick<
  CachedObject<ModelVersionMetricLookup>,
  'fetch' | 'bust' | 'refresh' | 'flush'
> = {
  fetch: async (ids: number | number[]): Promise<Record<string, ModelVersionMetricLookup>> => {
    if (!Array.isArray(ids)) ids = [ids];
    if (ids.length === 0) return {};

    // Populate missing metrics from ClickHouse (uses per-ID locks internally)
    await populateEntityMetrics('ModelVersion', ids);

    // Fetch from Redis
    const metricsMap = await entityMetricRedis.getBulkMetrics('ModelVersion', ids);

    const results: Record<string, ModelVersionMetricLookup> = {};
    for (const id of ids) {
      const metrics = metricsMap.get(id);

      // Calculate rating from thumbs up/down
      const thumbsUp = metrics?.ThumbsUp || 0;
      const thumbsDown = metrics?.ThumbsDown || 0;
      const ratingCount = thumbsUp + thumbsDown;
      const rating = ratingCount > 0 ? (thumbsUp / ratingCount) * 5 : null;

      results[id] = {
        modelVersionId: id,
        thumbsUpCount: metrics?.ThumbsUp || null,
        thumbsDownCount: metrics?.ThumbsDown || null,
        commentCount: metrics?.Comment || null,
        downloadCount: metrics?.Download || null,
        generationCount: metrics?.Generation || null,
        favoriteCount: metrics?.Favorite || null,
        imageCount: metrics?.Image || null,
        earnedAmount: metrics?.Earned || null,
        rating,
        ratingCount: ratingCount || null,
      };
    }
    return results;
  },

  bust: async (ids: number | number[]) => {
    if (!Array.isArray(ids)) ids = [ids];
    if (ids.length === 0) return;

    // Delete from Redis to force re-fetch from ClickHouse
    await Promise.all(ids.map((id) => entityMetricRedis.delete('ModelVersion', id)));
  },

  refresh: async (ids: number | number[], skipCache?: boolean) => {
    if (!Array.isArray(ids)) ids = [ids];
    if (ids.length === 0) return;

    // Force refresh from ClickHouse with forceRefresh=true to overwrite existing values
    await populateEntityMetrics('ModelVersion', ids, true);
  },

  flush: async () => {
    // Clear all model version metrics from Redis - Not Supported
  },
};
