/** The models search index. The main app's `modelsSearchIndex` queues under this name. */
export const MODELS_SEARCH_INDEX = 'models_v9';

/**
 * Postgres parking lot for search-index enqueues that could not reach the queue: one `KeyValue` row
 * per queue key, holding a JSON array of ids. The main app's `search-index-queue-drain` job replays
 * it onto the queue.
 *
 * `Delete` is why it exists: a dropped `Update` is re-derived by the delta `updatedAt` range-scan,
 * but nothing can re-derive a delete from a row that is already gone. An update the range-scan cannot
 * see (a model whose showcase changed while `Model.updatedAt` did not) is parked for the same reason.
 */
export const SEARCH_INDEX_QUEUE_FALLBACK_PREFIX = 'search-index-queue-fallback:';

/**
 * Ceiling per row. A single fan-out can carry ~211K ids and this is a JSON column, not a queue: past
 * this the parking lot stops absorbing rather than growing without bound through a long outage.
 * Hitting it means the outage needs a full reindex, not a replay.
 */
export const SEARCH_INDEX_QUEUE_FALLBACK_MAX_IDS = 100000;

export const searchIndexQueueFallbackKey = (indexName: string, action: 'Update' | 'Delete') =>
  `${SEARCH_INDEX_QUEUE_FALLBACK_PREFIX}${indexName}:${action}`;
