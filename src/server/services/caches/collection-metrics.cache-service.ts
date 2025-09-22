import { entityMetricRedis } from '~/server/redis/entity-metric.redis';
import { populateEntityMetrics } from '~/server/redis/entity-metric-populate';
import type { CachedObject } from '~/server/utils/cache-helpers';

export type CollectionMetricLookup = {
  collectionId: number;
  itemCount: number | null;
  followerCount: number | null;
  contributorCount: number | null;
};

/**
 * Collection metrics cache using direct Redis entity metrics
 * Follows the same pattern as imageMetricsCache
 */
export const collectionMetricsCache: Pick<
  CachedObject<CollectionMetricLookup>,
  'fetch' | 'bust' | 'refresh' | 'flush'
> = {
  fetch: async (ids: number | number[]): Promise<Record<string, CollectionMetricLookup>> => {
    if (!Array.isArray(ids)) ids = [ids];
    if (ids.length === 0) return {};

    // Populate missing metrics from ClickHouse (uses per-ID locks internally)
    await populateEntityMetrics('Collection', ids);

    // Fetch from Redis
    const metricsMap = await entityMetricRedis.getBulkMetrics('Collection', ids);

    const results: Record<string, CollectionMetricLookup> = {};
    for (const id of ids) {
      const metrics = metricsMap.get(id);
      results[id] = {
        collectionId: id,
        itemCount: metrics?.Item || null,
        followerCount: metrics?.Follower || null,
        contributorCount: metrics?.Contributor || null,
      };
    }
    return results;
  },

  bust: async (ids: number | number[]) => {
    if (!Array.isArray(ids)) ids = [ids];
    if (ids.length === 0) return;

    // Delete from Redis to force re-fetch from ClickHouse
    await Promise.all(ids.map((id) => entityMetricRedis.delete('Collection', id)));
  },

  refresh: async (ids: number | number[], skipCache?: boolean) => {
    if (!Array.isArray(ids)) ids = [ids];
    if (ids.length === 0) return;

    // Force refresh from ClickHouse with forceRefresh=true to overwrite existing values
    await populateEntityMetrics('Collection', ids, true);
  },

  flush: async () => {
    // Clear all collection metrics from Redis - Not Supported
  },
};