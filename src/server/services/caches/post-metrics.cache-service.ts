import { createEntityMetricsCache, getMetricValue, sumMetrics } from './entity-metrics.cache-helper';

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
export const postMetricsCache = createEntityMetricsCache<PostMetricLookup>({
  entityType: 'Post',
  transformMetrics: (entityId, metrics) => ({
    postId: entityId,
    reactionCount: sumMetrics(metrics, ['ReactionLike', 'ReactionHeart', 'ReactionLaugh', 'ReactionCry']),
    commentCount: getMetricValue(metrics, 'Comment'),
    collectionCount: getMetricValue(metrics, 'Collection'),
    buzzAmount: getMetricValue(metrics, 'Buzz'),
    tipCount: getMetricValue(metrics, 'Tip'),
  }),
});