// ~/server/metric/feed-image-existence-check.metrics.ts
import client, { type Counter, type Histogram, type Registry } from 'prom-client';

type MetricsBundle = {
  requestTotal: Counter<string>;
  cacheHitRequestsTotal: Counter<string>;
  ffRequestsTotal: Counter<string>;
  requestDurationSeconds: Histogram<string>;
  droppedIdsTotal: Counter<string>;
  postFilterIterations: Histogram<string>;
  postFilterDocsProcessed: Counter<string>;
  postFilterFilterRatio: Histogram<string>;
};

function getOrCreateCounter(
  reg: Registry,
  name: string,
  help: string,
  labelNames: string[]
): Counter<string> {
  const existing = reg.getSingleMetric(name) as Counter<string> | undefined;
  if (existing) return existing;
  return new client.Counter({ name, help, labelNames, registers: [reg] });
}

function getOrCreateHistogram(
  reg: Registry,
  name: string,
  help: string,
  labelNames: string[],
  buckets?: number[]
): Histogram<string> {
  const existing = reg.getSingleMetric(name) as Histogram<string> | undefined;
  if (existing) return existing;
  return new client.Histogram({ name, help, labelNames, buckets, registers: [reg] });
}

/**
 * Idempotent: safe to call multiple times.
 * Returns the metric instances (existing or newly created).
 */
export function ensureRegisterFeedImageExistenceCheckMetrics(
  reg: Registry = client.register
): MetricsBundle {
  const requestTotal = getOrCreateCounter(
    reg,
    'images_search_requests_total',
    'Total requests to getImagesFromSearch',
    ['route']
  );

  const cacheHitRequestsTotal = getOrCreateCounter(
    reg,
    'images_search_cache_hit_requests_total',
    'Requests by cache hit type',
    ['route', 'hit_type'] // full | partial | miss
  );

  const ffRequestsTotal = getOrCreateCounter(
    reg,
    'images_search_ff_requests_total',
    'Requests by feature-flag status',
    ['route', 'enabled'] // true | false
  );

  const requestDurationSeconds = getOrCreateHistogram(
    reg,
    'images_search_request_duration_seconds',
    'Request duration in seconds',
    ['route'],
    [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5]
  );

  /** Total number of IDs dropped after existence checks */
  const droppedIdsTotal = getOrCreateCounter(
    reg,
    'images_search_dropped_ids_total',
    'Total image IDs dropped after existence checks',
    ['route', 'hit_type']
  );

  /** Number of loop iterations per PostFilter request */
  const postFilterIterations = getOrCreateHistogram(
    reg,
    'images_search_postfilter_iterations',
    'Number of Meilisearch getDocuments calls per PostFilter request',
    ['route'],
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  );

  /** Total documents fetched from Meilisearch across all PostFilter iterations */
  const postFilterDocsProcessed = getOrCreateCounter(
    reg,
    'images_search_postfilter_docs_processed_total',
    'Total documents fetched from Meilisearch by PostFilter',
    ['route']
  );

  /** Filter ratio (fraction of results rejected) per PostFilter request */
  const postFilterFilterRatio = getOrCreateHistogram(
    reg,
    'images_search_postfilter_filter_ratio',
    'Fraction of fetched results rejected by PostFilter (0=none filtered, 1=all filtered)',
    ['route'],
    [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0]
  );

  const bundle = {
    requestTotal,
    cacheHitRequestsTotal,
    ffRequestsTotal,
    requestDurationSeconds,
    droppedIdsTotal,
    postFilterIterations,
    postFilterDocsProcessed,
    postFilterFilterRatio,
  };

  return bundle;
}
