/**
 * Barrel export for all entity metric cache services
 * These caches use direct Redis entity metrics with ClickHouse population
 */

// Export the unified helper for custom implementations
export { createEntityMetricsCache, getMetricValue, sumMetrics, calculateRating } from './entity-metrics.cache-helper';
export type { EntityType, MetricTransformConfig } from './entity-metrics.cache-helper';

// Individual cache services
export {
  imageMetricsCache,
  type ImageMetricLookup,
} from './image-metrics.cache-service';

export {
  postMetricsCache,
  type PostMetricLookup,
} from './post-metrics.cache-service';

export {
  modelMetricsCache,
  modelVersionMetricsCache,
  type ModelMetricLookup,
  type ModelVersionMetricLookup,
} from './model-metrics.cache-service';

export {
  collectionMetricsCache,
  type CollectionMetricLookup,
} from './collection-metrics.cache-service';

export {
  userMetricsCache,
  type UserMetricLookup,
} from './user-metrics.cache-service';