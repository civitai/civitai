import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';
import { config } from './config';

// Create a custom registry
export const register = new Registry();

// Set default labels for all metrics
register.setDefaultLabels({
  app: 'metric-event-watcher',
  env: config.app.nodeEnv,
});

// Collect default Node.js metrics
collectDefaultMetrics({
  register,
  prefix: 'mew_',
});

// Event Processor Metrics
export const eventProcessorMetrics = {
  messagesReceived: new Counter({
    name: 'mew_messages_received_total',
    help: 'Total number of messages received from Kafka',
    labelNames: ['topic', 'operation'],
    registers: [register],
  }),
  messagesIgnored: new Counter({
    name: 'mew_messages_ignored_total',
    help: 'Total number of messages ignored (no handlers matched)',
    labelNames: ['topic', 'operation'],
    registers: [register],
  }),
  messagesPoisoned: new Counter({
    name: 'mew_messages_poisoned_total',
    help: 'Messages skipped after a deterministic (non-retriable) handler error. A poison-pill message that would otherwise crash-wedge the consumer is logged and its offset advanced instead.',
    labelNames: ['topic', 'reason'],
    registers: [register],
  }),
  handlersMatched: new Counter({
    name: 'mew_handlers_matched_total',
    help: 'Total number of handlers matched for messages',
    labelNames: ['topic', 'operation', 'handler'],
    registers: [register],
  }),
  eventsQueued: new Counter({
    name: 'mew_events_queued_total',
    help: 'Total number of events queued for processing',
    labelNames: ['handler'],
    registers: [register],
  }),
  eventsDropped: new Counter({
    name: 'mew_events_dropped_total',
    help: 'Total number of events dropped due to queuing failures',
    labelNames: ['handler', 'reason'],
    registers: [register],
  }),
  eventsProcessed: new Counter({
    name: 'mew_events_processed_total',
    help: 'Total number of events processed',
    labelNames: ['handler', 'status'],
    registers: [register],
  }),
  eventsRetried: new Counter({
    name: 'mew_events_retried_total',
    help: 'Total number of events retried',
    labelNames: ['handler', 'attempt'],
    registers: [register],
  }),
  eventsFailed: new Counter({
    name: 'mew_events_failed_total',
    help: 'Total number of events that failed after max retries',
    labelNames: ['handler'],
    registers: [register],
  }),
  activeTasks: new Gauge({
    name: 'mew_active_tasks',
    help: 'Number of currently active event processing tasks',
    registers: [register],
  }),
  pendingTasks: new Gauge({
    name: 'mew_pending_tasks',
    help: 'Number of tasks waiting to be processed',
    registers: [register],
  }),
  retryQueueSize: new Gauge({
    name: 'mew_retry_queue_size',
    help: 'Number of events in the retry queue',
    registers: [register],
  }),
  eventProcessingDuration: new Histogram({
    name: 'mew_event_processing_duration_seconds',
    help: 'Duration of event processing',
    labelNames: ['handler'],
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
    registers: [register],
  }),
};

// Metric Event Batcher Metrics
export const metricBatcherMetrics = {
  batchesFlushed: new Counter({
    name: 'mew_metric_batches_flushed_total',
    help: 'Total number of metric batches flushed to ClickHouse',
    registers: [register],
  }),
  batchesFailed: new Counter({
    name: 'mew_metric_batches_failed_total',
    help: 'Total number of failed metric batch flushes',
    registers: [register],
  }),
  offsetCommitFailures: new Counter({
    name: 'mew_offset_commit_failures_total',
    help: 'Total number of Kafka offset commit failures after a successful ClickHouse flush. A spike means offsets are not advancing: events redeliver (CH dedupes; the cache apply is held until a commit lands).',
    registers: [register],
  }),
  eventsInBatches: new Counter({
    name: 'mew_metric_events_batched_total',
    help: 'Total number of metric events batched',
    registers: [register],
  }),
  queueSize: new Gauge({
    name: 'mew_metric_batch_queue_size',
    help: 'Current number of events in the metric batch queue',
    registers: [register],
  }),
  batchFlushDuration: new Histogram({
    name: 'mew_metric_batch_flush_duration_seconds',
    help: 'Duration of metric batch flush operations',
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
    registers: [register],
  }),
};

// Index Update Queue Metrics
export const indexQueueMetrics = {
  batchesFlushed: new Counter({
    name: 'mew_index_batches_flushed_total',
    help: 'Total number of index update batches flushed',
    labelNames: ['entity_type'],
    registers: [register],
  }),
  batchesFailed: new Counter({
    name: 'mew_index_batches_failed_total',
    help: 'Total number of failed index update batches',
    registers: [register],
  }),
  updatesProcessed: new Counter({
    name: 'mew_index_updates_processed_total',
    help: 'Total number of index updates processed',
    labelNames: ['entity_type'],
    registers: [register],
  }),
  queueSize: new Gauge({
    name: 'mew_index_queue_size',
    help: 'Current number of entities in index update queue',
    labelNames: ['entity_type'],
    registers: [register],
  }),
  batchFlushDuration: new Histogram({
    name: 'mew_index_batch_flush_duration_seconds',
    help: 'Duration of index batch flush operations',
    labelNames: ['entity_type'],
    buckets: [0.1, 0.5, 1, 2, 5, 10],
    registers: [register],
  }),
};

// Metric Signals Metrics
export const signalsMetrics = {
  signalsSent: new Counter({
    name: 'mew_signals_sent_total',
    help: 'Total number of metric delta signals sent',
    registers: [register],
  }),
  signalsFailed: new Counter({
    name: 'mew_signals_failed_total',
    help: 'Total number of failed metric delta signals',
    registers: [register],
  }),
};

// Redis Cache Metrics
export const redisCacheMetrics = {
  cacheUpdates: new Counter({
    name: 'mew_redis_cache_updates_total',
    help: 'Total number of Redis cache updates',
    labelNames: ['operation'],
    registers: [register],
  }),
  cacheErrors: new Counter({
    name: 'mew_redis_cache_errors_total',
    help: 'Total number of Redis cache errors',
    labelNames: ['operation'],
    registers: [register],
  }),
};

// Cache Drift Monitor Metrics
// Periodically compares the Redis metric cache against the deduped ClickHouse
// ground truth for a sample of hot entities. This is the leading indicator for
// the ~2x drift class of bug: if the gating regresses, or the populate/naming
// diverges, mew_cache_drift_ratio departs from 1.0 and alerts fire — instead of
// the drift being discovered by eye.
export const cacheDriftMetrics = {
  ratio: new Gauge({
    name: 'mew_cache_drift_ratio',
    help: 'Ratio of the Redis cached metric total to the ClickHouse ground truth for sampled entities (1.0 = exact). stat: max|p95|mean.',
    labelNames: ['entity_type', 'stat'],
    registers: [register],
  }),
  entitiesChecked: new Gauge({
    name: 'mew_cache_drift_entities_checked',
    help: 'Number of (non-zero-truth) entities compared in the last drift check',
    labelNames: ['entity_type'],
    registers: [register],
  }),
  entitiesDrifted: new Gauge({
    name: 'mew_cache_drift_entities_over_threshold',
    help: 'Number of sampled entities whose Redis/CH ratio was outside the drift threshold in the last check',
    labelNames: ['entity_type'],
    registers: [register],
  }),
  checkErrors: new Counter({
    name: 'mew_cache_drift_check_errors_total',
    help: 'Total number of cache drift check runs that errored',
    registers: [register],
  }),
};

// Outbox Poller Metrics
export const outboxPollerMetrics = {
  // Standing count of parked rows (attempts >= max). Re-sampled each sweep.
  // ALERT ON THIS: parked rows are reclaims/side-effects that have exhausted
  // their retry budget and will NOT run again until re-driven.
  parked: new Gauge({
    name: 'mew_outbox_parked',
    help: 'Current number of Outbox rows parked after exhausting the retry budget (attempts >= max)',
    registers: [register],
  }),
  // Increments each time a row crosses into the parked state.
  parkedTotal: new Counter({
    name: 'mew_outbox_parked_total',
    help: 'Total Outbox rows parked after their handler failed maxAttempts times',
    labelNames: ['entity_type', 'event'],
    registers: [register],
  }),
  drained: new Counter({
    name: 'mew_outbox_drained_total',
    help: 'Total Outbox rows successfully processed and deleted by the poller',
    registers: [register],
  }),
};

// Query Cache Metrics (LRU cache for PostgreSQL queries)
export const queryCacheMetrics = {
  size: new Gauge({
    name: 'mew_query_cache_size_bytes',
    help: 'Current size of the query cache in bytes',
    registers: [register],
  }),
  count: new Gauge({
    name: 'mew_query_cache_count',
    help: 'Number of entries in the query cache',
    registers: [register],
  }),
  hits: new Counter({
    name: 'mew_query_cache_hits_total',
    help: 'Total number of query cache hits',
    registers: [register],
  }),
  misses: new Counter({
    name: 'mew_query_cache_misses_total',
    help: 'Total number of query cache misses',
    registers: [register],
  }),
  evictions: new Counter({
    name: 'mew_query_cache_evictions_total',
    help: 'Total number of query cache evictions',
    labelNames: ['reason'],
    registers: [register],
  }),
  syncMessagesSent: new Counter({
    name: 'mew_query_cache_sync_messages_sent_total',
    help: 'Total number of cache sync messages published to Redis',
    labelNames: ['type'],
    registers: [register],
  }),
  syncMessagesReceived: new Counter({
    name: 'mew_query_cache_sync_messages_received_total',
    help: 'Total number of cache sync messages received from Redis',
    labelNames: ['type'],
    registers: [register],
  }),
  syncErrors: new Counter({
    name: 'mew_query_cache_sync_errors_total',
    help: 'Total number of cache sync errors',
    labelNames: ['operation'],
    registers: [register],
  }),
  backupsCompleted: new Counter({
    name: 'mew_query_cache_backups_completed_total',
    help: 'Total number of successful cache backups',
    registers: [register],
  }),
  backupsFailed: new Counter({
    name: 'mew_query_cache_backups_failed_total',
    help: 'Total number of failed cache backups',
    registers: [register],
  }),
  backupDuration: new Histogram({
    name: 'mew_query_cache_backup_duration_seconds',
    help: 'Duration of cache backup operations',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [register],
  }),
  backupSize: new Gauge({
    name: 'mew_query_cache_backup_compressed_bytes',
    help: 'Size of the last compressed cache backup in bytes',
    registers: [register],
  }),
  backupEntries: new Gauge({
    name: 'mew_query_cache_backup_entries',
    help: 'Number of entries in the last cache backup',
    registers: [register],
  }),
  restoresCompleted: new Counter({
    name: 'mew_query_cache_restores_completed_total',
    help: 'Total number of successful cache restores',
    registers: [register],
  }),
  restoresFailed: new Counter({
    name: 'mew_query_cache_restores_failed_total',
    help: 'Total number of failed cache restores',
    registers: [register],
  }),
  restoreDuration: new Histogram({
    name: 'mew_query_cache_restore_duration_seconds',
    help: 'Duration of cache restore operations',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [register],
  }),
};
