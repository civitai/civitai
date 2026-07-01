// Prometheus metrics for the notifications app (mirrors apps/orchestrator-gateway/src/lib/server/metrics.ts).
//
// Cardinality discipline: labels are bounded, low-cardinality enums ONLY. NEVER put userId (or any
// unbounded value) in a label. All series are registered at module load with their full label sets so
// they export a baseline before the first event.

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
