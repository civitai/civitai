import { entityMetricRedis } from '~/server/redis/entity-metric.redis';
import { populateEntityMetrics } from '~/server/redis/entity-metric-populate';
import type { CachedObject } from '~/server/utils/cache-helpers';

export type PostMetricLookup = {
  postId: number;
  reactionCount: number | null;
  commentCount: number | null;
  collectionCount: number | null;
  buzzAmount: number | null;
  tipCount: number | null;
};

/**
 * Post metrics cache using direct Redis entity metrics
 * Follows the same pattern as imageMetricsCache
 */
export const postMetricsCache: Pick<
  CachedObject<PostMetricLookup>,
  'fetch' | 'bust' | 'refresh' | 'flush'
> = {
  fetch: async (ids: number | number[]): Promise<Record<string, PostMetricLookup>> => {
    if (!Array.isArray(ids)) ids = [ids];
    if (ids.length === 0) return {};

    // Populate missing metrics from ClickHouse (uses per-ID locks internally)
    await populateEntityMetrics('Post', ids);

    // Fetch from Redis
    const metricsMap = await entityMetricRedis.getBulkMetrics('Post', ids);

    const results: Record<string, PostMetricLookup> = {};
    for (const id of ids) {
      const metrics = metricsMap.get(id);

      // Aggregate all reaction types into total count
      const reactionCount =
        (metrics?.ReactionLike || 0) +
        (metrics?.ReactionHeart || 0) +
        (metrics?.ReactionLaugh || 0) +
        (metrics?.ReactionCry || 0);

      results[id] = {
        postId: id,
        reactionCount: reactionCount || null,
        commentCount: metrics?.Comment || null,
        collectionCount: metrics?.Collection || null,
        buzzAmount: metrics?.Buzz || null,
        tipCount: metrics?.Tip || null,
      };
    }
    return results;
  },

  bust: async (ids: number | number[]) => {
    if (!Array.isArray(ids)) ids = [ids];
    if (ids.length === 0) return;

    // Delete from Redis to force re-fetch from ClickHouse
    await Promise.all(ids.map((id) => entityMetricRedis.delete('Post', id)));
  },

  refresh: async (ids: number | number[], skipCache?: boolean) => {
    if (!Array.isArray(ids)) ids = [ids];
    if (ids.length === 0) return;

    // Force refresh from ClickHouse with forceRefresh=true to overwrite existing values
    await populateEntityMetrics('Post', ids, true);
  },

  flush: async () => {
    // Clear all post metrics from Redis - Not Supported
  },
};