import { entityMetricRedis } from '~/server/redis/entity-metric.redis';
import { populateEntityMetrics } from '~/server/redis/entity-metric-populate';
import type { CachedObject } from '~/server/utils/cache-helpers';

export type ImageMetricLookup = {
  imageId: number;
  reactionLike: number | null;
  reactionHeart: number | null;
  reactionLaugh: number | null;
  reactionCry: number | null;
  comment: number | null;
  collection: number | null;
  buzz: number | null;
};

/**
 * Image metrics cache using direct Redis entity metrics
 * Implements the same interface as CachedObject for compatibility
 */
export const imageMetricsCache: Pick<
  CachedObject<ImageMetricLookup>,
  'fetch' | 'bust' | 'refresh' | 'flush'
> = {
  fetch: async (ids: number | number[]): Promise<Record<string, ImageMetricLookup>> => {
    if (!Array.isArray(ids)) ids = [ids];
    if (ids.length === 0) return {};

    // Populate missing metrics from ClickHouse (uses per-ID locks internally)
    await populateEntityMetrics('Image', ids);

    // Fetch from Redis
    const metricsMap = await entityMetricRedis.getBulkMetrics('Image', ids);

    const results: Record<string, ImageMetricLookup> = {};
    for (const id of ids) {
      const metrics = metricsMap.get(id);
      results[id] = {
        imageId: id,
        reactionLike: metrics?.ReactionLike || null,
        reactionHeart: metrics?.ReactionHeart || null,
        reactionLaugh: metrics?.ReactionLaugh || null,
        reactionCry: metrics?.ReactionCry || null,
        comment: metrics?.Comment || null,
        collection: metrics?.Collection || null,
        buzz: metrics?.Buzz || null,
      };
    }
    return results;
  },

  bust: async (ids: number | number[]) => {
    if (!Array.isArray(ids)) ids = [ids];
    if (ids.length === 0) return;

    // Delete from Redis to force re-fetch from ClickHouse
    await Promise.all(ids.map((id) => entityMetricRedis.delete('Image', id)));
  },

  refresh: async (ids: number | number[], skipCache?: boolean) => {
    if (!Array.isArray(ids)) ids = [ids];
    if (ids.length === 0) return;

    // Force refresh from ClickHouse with forceRefresh=true to overwrite existing values
    await populateEntityMetrics('Image', ids, true);
  },

  flush: async () => {
    // Clear all image metrics from Redis - Not Supported
  },
};