// Event Engine Common - Shared services and utilities for Civitai event engine applications

// Services
export { MetricService } from './services/metrics';
export { OutboxService } from './services/outbox';
export type { OutboxRecord } from './services/outbox';
export { SignalsService } from './services/signals';

// Types - All metric types
export type {
  ArticleMetrics,
  BountyMetrics,
  BountyEntryMetrics,
  CollectionMetrics,
  ImageMetrics,
  ModelMetrics,
  ModelVersionMetrics,
  PostMetrics,
  TagMetrics,
  UserMetrics,
  EntityMetrics,
  EntityType,
  EntityMetricMap,
} from './types/metric-types';

export { ENTITY_METRIC_TYPES } from './types/metric-types';

// Package stubs for external dependencies
export type {
  IRedisClient,
  IClickhouseClient,
  IPgClient,
} from './types/package-stubs';

// Utilities
export { chunk, sleep } from './utils/basic';
export { cacheKeys } from './utils/cache-keys';

// Query utilities - both types and implementations
export type { RedisWithHelpers } from './utils/query-utils';
export { SimpleClickhouse, withRedisHelpers } from './utils/query-utils';

// Meilisearch types
export type {
  ModelRawItem,
  ImageMetricsSearchIndexRecord,
  ImageFeedResult,
  ModelFeedResponse,
  ImageFeedResponse,
} from './types/meilisearch/documents';

export type {
  ModelFeedInput,
  ImageFeedInput,
  FeedOptions,
  SortOption,
} from './types/meilisearch/inputs';

export {
  MODELS_INDEX_CONFIG,
  METRICS_MODELS_INDEX_CONFIG,
  IMAGES_INDEX_CONFIG,
  METRICS_IMAGES_INDEX_CONFIG,
  INDEX_NAMES,
} from './types/meilisearch/index-configs';

export {
  MODEL_SORT_OPTIONS,
  IMAGE_SORT_OPTIONS,
} from './types/meilisearch/inputs';

export type {
  IndexConfig,
  IndexName,
} from './types/meilisearch/index-configs';

// Meilisearch exports (direct from package)
export type { MeiliSearch, SearchResponse } from 'meilisearch';
