/**
 * One shared flush window for the browser's batched tRPC queries (`trpcUnifiedBatchWindow` flag).
 *
 * Without it, every coalescer runs its own clock: the batch link sends whatever was queued in the
 * same task (a 0 ms timer, once per tRPC client), the engaged-models batcher flushes 80 ms after its
 * first id and the sale-badge batcher 50 ms after its first id. Queries that start a few ms apart,
 * or on different clocks, leave as separate HTTP requests even when every one of them could have
 * shared a batch.
 *
 * With the flag on, all of them wait for the same window instead: it opens at the first query or
 * batcher flush, closes `TRPC_BATCH_WINDOW_MS` later (it does not slide, so latency is bounded), and
 * everything queued in it is released in ONE task, so the batch link sends it as one request per
 * URL/item cap. Work queued while the window is being released (a batcher's own query) joins that
 * release rather than opening a new window.
 *
 * It applies only where batching applies (`trpcBatching` on, signed-in browser): an unbatched query
 * leaves as its own request whatever the clock, so shortening a batcher's window there would only
 * add requests. That check lives in `~/utils/trpc` and is registered here, so this module imports
 * nothing and a test that replaces `~/utils/trpc` with a stub falls back to each batcher's own timer.
 */

export const TRPC_BATCH_WINDOW_MS = 16;

let enabled = false;
/** Set from `FeatureFlagsProvider`, browser only. */
export function setTrpcUnifiedBatchWindowEnabled(value: boolean) {
  enabled = value;
}
export function getTrpcUnifiedBatchWindowEnabled() {
  return enabled;
}

let batchingApplies: () => boolean = () => false;
/** Registered by `~/utils/trpc`: whether a query from this browser rides the batch link at all. */
export function registerBatchingApplies(predicate: () => boolean) {
  batchingApplies = predicate;
}

/** Whether coalescers should use the shared window right now. */
export function isUnifiedBatchWindowActive() {
  return enabled && batchingApplies();
}

let queue: Array<() => void> = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let releasing = false;

function runSafely(run: () => void) {
  try {
    run();
  } catch (error) {
    // One failing callback must not strand the rest of the window.
    console.error('[trpc] batch window callback failed', error);
  }
}

function release() {
  timer = null;
  // The release lasts until this task's microtasks have run, not just this loop: the sale-badge
  // batcher sends from a promise continuation, and that query must still leave with this release.
  // This timer is queued before any query released below reaches the batch link, whose own 0 ms
  // dispatch timer therefore fires after it, with everything released here in one request.
  releasing = true;
  setTimeout(() => {
    releasing = false;
  }, 0);
  const due = queue;
  queue = [];
  for (const run of due) runSafely(run);
}

/**
 * Runs `run` when the shared window closes, or now if the window is being released (so work a
 * released callback starts joins the same request). Callers check `isUnifiedBatchWindowActive`.
 */
export function deferToBatchWindow(run: () => void) {
  if (releasing) return runSafely(run);
  queue.push(run);
  if (timer === null) timer = setTimeout(release, TRPC_BATCH_WINDOW_MS);
}

/**
 * A hand-rolled batcher's flush timer. On the shared window while it is active; otherwise the
 * batcher's own `ownWindowMs` timer, exactly as before the flag.
 */
export function scheduleBatcherFlush(flush: () => void, ownWindowMs: number) {
  if (isUnifiedBatchWindowActive()) deferToBatchWindow(flush);
  else setTimeout(flush, ownWindowMs);
}

/** Test-only: drop queued work and the flag. */
export function __resetTrpcBatchWindow() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  queue = [];
  releasing = false;
  enabled = false;
}
