// Per-pod (per-process) admission control for CPU-heavy routes.
//
// Node.js runs ONE JS thread. The feed/image endpoints do seconds of synchronous
// CPU (Meili result processing, response shaping, serialization). When a traffic
// surge pushes more of these onto a pod than its single thread can drain, a
// backlog forms: the event loop is blocked for tens of seconds → the pod can't
// answer its liveness/readiness probes or its /metrics scrape → Error/137
// SIGKILL → 504s + a self-amplifying cascade as load shifts to the survivors.
// (Verified on the 2026-06-07 wave: 11 pods pinned, the HPA was blind because the
// pinned pods dropped out of metric scraping.)
//
// This bulkhead caps concurrent in-flight heavy requests PER POD and FAST-FAILS
// the excess instead of letting an unbounded backlog pin the thread. A quick
// 429/503 that the client/LB retries (or backs off on) is strictly better than a
// 504 after a 30s timeout on a pod that is about to be killed.
//
// It is a SAFETY VALVE, not aggressive shedding: the default limit is set high
// enough not to shed under normal peak, so it only trips on a pathological
// pile-up. Tune via HEAVY_REQUEST_CONCURRENCY once per-route concurrency data is
// available (watch the reject counter vs the pin/restart rate).
//
// Correctness: Node is single-threaded, so the check-then-increment below is
// atomic (no preemption between the comparison and `active++` — it's synchronous).

export class BulkheadFullError extends Error {
  constructor(public readonly key: string, public readonly limit: number) {
    super(`bulkhead "${key}" at capacity (${limit})`);
    this.name = 'BulkheadFullError';
  }
}

type Slot = { active: number };
const slots = new Map<string, Slot>();

// Process-wide reject counter (per key) for observability / tuning.
const rejects = new Map<string, number>();

/**
 * Acquire one concurrency slot for `key`. Throws BulkheadFullError IMMEDIATELY
 * (no queueing) when `limit` in-flight is already reached. Returns a release fn
 * that MUST be called in a finally.
 */
export function acquireBulkheadSlot(key: string, limit: number): () => void {
  let slot = slots.get(key);
  if (!slot) {
    slot = { active: 0 };
    slots.set(key, slot);
  }
  if (slot.active >= limit) {
    rejects.set(key, (rejects.get(key) ?? 0) + 1);
    throw new BulkheadFullError(key, limit);
  }
  slot.active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    slot!.active--;
  };
}

/** Run `fn` inside a bulkhead slot; throws BulkheadFullError when full. */
export async function withBulkheadSlot<T>(
  key: string,
  limit: number,
  fn: () => Promise<T>
): Promise<T> {
  const release = acquireBulkheadSlot(key, limit);
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Snapshot of current in-flight + cumulative rejects per key (for logging/metrics). */
export function bulkheadSnapshot() {
  return [...slots].map(([key, s]) => ({ key, active: s.active, rejects: rejects.get(key) ?? 0 }));
}

export const HEAVY_REQUEST_CONCURRENCY = (() => {
  const n = parseInt(process.env.HEAVY_REQUEST_CONCURRENCY ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 20; // safety-valve default; tune down if pins persist
})();

// Log the resolved limit once at init so the deployed value is visible — a typo
// like `=2` (intending 20) would silently shed hard, with no signal except the
// reject gauge. Server-only (this module is imported by trpc.ts / the REST handler).
if (typeof window === 'undefined') {
  // eslint-disable-next-line no-console
  console.log(`[bulkhead] HEAVY_REQUEST_CONCURRENCY=${HEAVY_REQUEST_CONCURRENCY}`);
}
