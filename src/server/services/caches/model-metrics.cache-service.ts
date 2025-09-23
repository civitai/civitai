import { createEntityMetricsCache, getMetricValue, calculateRating } from './entity-metrics.cache-helper';

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
export const modelMetricsCache = createEntityMetricsCache<ModelMetricLookup>({
  entityType: 'Model',
  transformMetrics: (entityId, metrics) => {
    const { rating, ratingCount } = calculateRating(metrics);

    return {
      modelId: entityId,
      thumbsUpCount: getMetricValue(metrics, 'ThumbsUp'),
      thumbsDownCount: getMetricValue(metrics, 'ThumbsDown'),
      commentCount: getMetricValue(metrics, 'Comment'),
      collectionCount: getMetricValue(metrics, 'Collection'),
      tipCount: getMetricValue(metrics, 'Tip'),
      buzzAmount: getMetricValue(metrics, 'Buzz'),
      downloadCount: getMetricValue(metrics, 'Download'),
      generationCount: getMetricValue(metrics, 'Generation'),
      favoriteCount: getMetricValue(metrics, 'Favorite'),
      imageCount: getMetricValue(metrics, 'Image'),
      earnedAmount: getMetricValue(metrics, 'Earned'),
      rating,
      ratingCount,
    };
  },
});

/**
 * Model version metrics cache using direct Redis entity metrics
 * Follows the same pattern as modelMetricsCache
 */
export const modelVersionMetricsCache = createEntityMetricsCache<ModelVersionMetricLookup>({
  entityType: 'ModelVersion',
  transformMetrics: (entityId, metrics) => {
    const { rating, ratingCount } = calculateRating(metrics);

    return {
      modelVersionId: entityId,
      thumbsUpCount: getMetricValue(metrics, 'ThumbsUp'),
      thumbsDownCount: getMetricValue(metrics, 'ThumbsDown'),
      commentCount: getMetricValue(metrics, 'Comment'),
      downloadCount: getMetricValue(metrics, 'Download'),
      generationCount: getMetricValue(metrics, 'Generation'),
      favoriteCount: getMetricValue(metrics, 'Favorite'),
      imageCount: getMetricValue(metrics, 'Image'),
      earnedAmount: getMetricValue(metrics, 'Earned'),
      rating,
      ratingCount,
    };
  },
});