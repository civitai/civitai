// ~/server/metric/feed-image-existence-check.metrics.ts
import client, { type Counter, type Histogram, type Registry } from 'prom-client';

type MetricsBundle = {
  requestTotal: Counter<string>;
  cacheHitRequestsTotal: Counter<string>;
  ffRequestsTotal: Counter<string>;
  requestDurationSeconds: Histogram<string>;
  droppedIdsTotal: Counter<string>;
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

  const bundle = {
    requestTotal,
    cacheHitRequestsTotal,
    ffRequestsTotal,
    requestDurationSeconds,
    droppedIdsTotal,
  };

  return bundle;
}
