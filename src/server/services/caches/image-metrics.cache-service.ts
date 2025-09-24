import { createEntityMetricsCache, getMetricValue } from './entity-metrics.cache-helper';

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
export const imageMetricsCache = createEntityMetricsCache<ImageMetricLookup>({
  entityType: 'Image',
  transformMetrics: (entityId, metrics) => ({
    imageId: entityId,
    reactionLike: getMetricValue(metrics, 'ReactionLike'),
    reactionHeart: getMetricValue(metrics, 'ReactionHeart'),
    reactionLaugh: getMetricValue(metrics, 'ReactionLaugh'),
    reactionCry: getMetricValue(metrics, 'ReactionCry'),
    comment: getMetricValue(metrics, 'Comment'),
    collection: getMetricValue(metrics, 'Collection'),
    buzz: getMetricValue(metrics, 'Buzz'),
  }),
});