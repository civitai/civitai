/**
 * Debounce decision for the model-metric → search-index flush.
 *
 * The model metric processor runs every minute and accumulates every model
 * whose `ModelVersionMetric.updatedAt` changed into a Redis SET (dedup). Those
 * ids are only flushed into the `models` search-index update queue on a
 * debounce window: the wider the window, the more a hot model's repeated
 * metric changes collapse into a single reindex, which shrinks the burst the
 * single-node search backend has to drain.
 *
 * This decision is factored out as a pure function so the timing/dedup
 * behaviour is unit-testable without Redis, env, or the search-index client.
 * The window itself is env-configurable (see
 * `SEARCH_INDEX_MODEL_METRIC_FLUSH_INTERVAL_MS`) so ops can widen or narrow it
 * at runtime without a redeploy.
 */
export function shouldFlushMetricSearchIndex(
  now: number,
  lastFlush: number,
  intervalMs: number
): boolean {
  return now - lastFlush >= intervalMs;
}
