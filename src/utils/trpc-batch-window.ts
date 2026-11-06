/**
 * One shared flush window for the browser's batched tRPC queries (`trpcUnifiedBatchWindow` flag).
 *
 * Without it, every coalescer runs its own clock: the batch link sends whatever was queued in the
 * same task (a 0 ms timer, once per tRPC client), the engaged-models batcher flushes 80 ms after its
 * first id and the sale-badge batcher 50 ms after its first id. Queries that start a few ms apart,
 * or on different clocks, leave as separate HTTP requests even when every one of them could have
 * shared a batch.
 *
 * With the flag on, batchable queries wait for one shared window instead: it opens at the first
 * query, closes `TRPC_BATCH_WINDOW_MS` later (it does not slide, so latency is bounded), and
 * everything queued in it is released in ONE task, so the batch link sends it as one request per
 * URL/item cap. The hand-rolled batchers keep their own collection windows, so they never split
 * their ids into more calls than without the flag; only their FLUSH moves: when a batcher's own
 * window ends, its flush joins the shared window that is open, or opens one and waits for it.
 *
 * It applies only where batching applies (`trpcBatching` on, signed-in browser): an unbatched query
 * leaves as its own request whatever the clock, so holding a batcher's flush there would only add
 * latency. That check lives in `~/utils/trpc` and is registered here, so this module imports
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
  releasing = true;
  try {
    const due = queue;
    queue = [];
    for (const run of due) runSafely(run);
  } finally {
    releasing = false;
  }
}

/**
 * Runs `run` when the shared window closes, or now if the window is being released, so a query a
 * released batcher flush sends joins the same request. That covers only work started SYNCHRONOUSLY
 * inside a released callback; both batchers send synchronously from their flush for that reason.
 * Callers check `isUnifiedBatchWindowActive`.
 */
export function deferToBatchWindow(run: () => void) {
  if (releasing) return runSafely(run);
  queue.push(run);
  if (timer === null) timer = setTimeout(release, TRPC_BATCH_WINDOW_MS);
}

/**
 * A hand-rolled batcher's flush timer. The batcher always collects for its own `ownWindowMs`, so
 * one flush carries exactly the ids it carries without the flag. When that window ends and the
 * shared window is active, the flush joins the open shared window (or the next one) so its call
 * leaves with the queries pending there; otherwise it runs at once, exactly as before the flag.
 */
export function scheduleBatcherFlush(flush: () => void, ownWindowMs: number) {
  setTimeout(() => {
    if (isUnifiedBatchWindowActive()) deferToBatchWindow(flush);
    else flush();
  }, ownWindowMs);
}

/** Test-only: drop queued work and the flag. */
export function __resetTrpcBatchWindow() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  queue = [];
  releasing = false;
  enabled = false;
}
