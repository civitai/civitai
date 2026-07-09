// Prometheus metrics for the notifications app (mirrors apps/orchestrator-gateway/src/lib/server/metrics.ts).
//
// Cardinality discipline: labels are bounded, low-cardinality enums ONLY. NEVER put userId (or any
// unbounded value) in a label. Counters/gauges are registered at module load with their full label sets
// so they export a baseline before the first event. The one exception is
// `notifications_http_request_duration_seconds`: its route×outcome cross-product is verbose and every
// series is bounded to a known route template anyway, so it uses standard first-observation series
// creation (a route×outcome series appears the first time that combination is served) rather than a
// pre-seeded baseline.

import { Registry, collectDefaultMetrics, Counter, Histogram, Gauge } from 'prom-client';

export const register = new Registry();
collectDefaultMetrics({ register });

/** Producer API POSTs, by outcome (created / rejected / unauthorized / error). */
export const producerRequestsTotal = new Counter({
  name: 'notifications_producer_requests_total',
  help: 'POST /notifications requests handled, labeled by outcome.',
  labelNames: ['outcome'] as const,
  registers: [register],
});

/** Fan-out worker tick duration (getPending → fan-out → signals for one poll pass). */
export const workerTickSeconds = new Histogram({
  name: 'notifications_worker_tick_seconds',
  help: 'Duration of one fan-out worker poll pass in seconds.',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [register],
});

/** PendingNotification rows processed per tick outcome (fanned / skipped / errored). */
export const workerPendingProcessedTotal = new Counter({
  name: 'notifications_worker_pending_processed_total',
  help: 'PendingNotification rows processed by the fan-out worker, labeled by outcome.',
  labelNames: ['outcome'] as const,
  registers: [register],
});

/** UserNotification rows created (fanned out) — the real notification volume. */
export const notificationsFannedOutTotal = new Counter({
  name: 'notifications_fanned_out_total',
  help: 'UserNotification rows created by fan-out.',
  registers: [register],
});

/** notif write-pool saturation, sampled each tick (active connections / total). */
export const writePoolActive = new Gauge({
  name: 'notifications_write_pool_active_connections',
  help: 'Active (non-idle) connections in the notif write pool, sampled per worker tick.',
  registers: [register],
});

/**
 * Read/mutation API RED — request duration (and, via `_count`, rate) for the authed POST routes, labeled
 * by `route` (the static route template, low cardinality) and `outcome` (derived from the status class:
 * success / rejected / unauthorized / error / client_error). Covers ALL authed routes uniformly — the
 * create path's finer-grained outcome breakdown stays on `notifications_producer_requests_total`; this
 * metric is the RED-across-routes view (query/count/mark-read/bulk/exists/cleanup had NO metric before).
 */
export const httpRequestDurationSeconds = new Histogram({
  name: 'notifications_http_request_duration_seconds',
  help: 'Authed API request duration in seconds, labeled by route and outcome.',
  labelNames: ['route', 'outcome'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

/**
 * Realtime-signal delivery outcome per affected user (the fan-out worker's per-user POST to
 * `${SIGNALS_ENDPOINT}/users/{id}/signals/...`). `failure` counts a non-2xx response OR a thrown/rejected
 * fetch — the exact silent-drop mode the OLD external notification-server had (POSTing to a non-existent
 * endpoint), previously visible only in Axiom. Delivery stays fire-and-forget; this only observes it.
 */
export const signalsDeliveryTotal = new Counter({
  name: 'notifications_signals_delivery_total',
  help: 'Realtime signal POSTs to the signals service, labeled by outcome (success/failure).',
  labelNames: ['outcome'] as const,
  registers: [register],
});

/**
 * Redis cache operation errors (the per-user unread-counter cache). The cache is best-effort — an error
 * on a counter op is logged/propagated as before; this counter just makes otherwise-silent redis failures
 * scrapeable/alertable. Labeled by `operation` (bounded enum of the cache ops).
 */
export const redisErrorsTotal = new Counter({
  name: 'notifications_redis_errors_total',
  help: 'Redis cache operation errors, labeled by operation.',
  labelNames: ['operation'] as const,
  registers: [register],
});

// Baseline series at load so they export a 0 before the first event (see the cardinality note above).
for (const outcome of ['success', 'failure'] as const) signalsDeliveryTotal.inc({ outcome }, 0);
for (const operation of ['get', 'set', 'increment', 'has', 'clearCategory', 'bustUser'] as const)
  redisErrorsTotal.inc({ operation }, 0);
