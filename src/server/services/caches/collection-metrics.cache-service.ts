import { createEntityMetricsCache, getMetricValue } from './entity-metrics.cache-helper';

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
export const collectionMetricsCache = createEntityMetricsCache<CollectionMetricLookup>({
  entityType: 'Collection',
  transformMetrics: (entityId, metrics) => ({
    collectionId: entityId,
    itemCount: getMetricValue(metrics, 'Item'),
    followerCount: getMetricValue(metrics, 'Follower'),
    contributorCount: getMetricValue(metrics, 'Contributor'),
  }),
});