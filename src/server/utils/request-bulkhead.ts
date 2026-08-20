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

// PROCESS-wide, not module-wide. Next.js compiles instrumentation.ts into a SEPARATE webpack
// bundle from the API-route/pages bundle, so a plain module-level `new Map()` here gives each
// graph its OWN state: the request path (pages graph) increments one map while a collect()
// closure created in the instrumentation graph reads a different, permanently empty one. That
// is not hypothetical — it is half of why civitai_app_heavy_bulkhead_* emitted no series at all
// between 2026-06-07 and this fix (the other half was the registry; see src/server/prom/client.ts).
//
// Pinning on globalThis — the real V8 global, shared across every webpack bundle in one Node
// process — is the same mechanism instrumentationRegistry and __civitaiRedisMetrics already use.
// The admission-control BEHAVIOUR was always correct in the graph that serves requests; only a
// reader in another graph saw nothing. Sharing the state makes the limit genuinely per-POD rather
// than per-pod-per-graph, which is what the cap was always documented to mean.
// ONE key holding BOTH maps, rather than a key each. The two are a single invariant — un-sharing
// either one reintroduces the defect on its own half — and `scripts/server-graph-watchlist.mjs`
// carries one `globalKey` per entry, so two keys would mean two watchlist entries naming the same
// module. That combination is not merely redundant, it is unenforceable: the gate's fixture emits
// one chunk per entry carrying only that entry's key, so each entry fails on the other's chunk and
// the module can never be green (measured — it red-lined the gate's own positive control).
declare global {
  // eslint-disable-next-line no-var
  var __civitaiBulkheadState:
    | { slots: Map<string, Slot>; rejects: Map<string, number> }
    | undefined;
}

// `??=` is the repo's canonical adopt-or-create form for these pins, matching
// `structured-log-sink.ts` and `server-fault-override.ts`. It is not a style preference:
// `scripts/__tests__/check-server-graph-singletons.test.ts` asserts this exact shape against
// comment-stripped source, so a key surviving only in prose, or a binding that quietly reverted to
// module scope, cannot pass for a real pin. `??=` specifically (not `=`) is what makes the SECOND
// copy adopt the first's state instead of replacing it — the original bug is `=` in one character.
const bulkheadState = (globalThis.__civitaiBulkheadState ??= {
  slots: new Map(),
  rejects: new Map(),
});

// Destructured once: both maps are only ever mutated in place, never reassigned, so these bindings
// stay pointed at the shared objects for the life of the process.
const slots = bulkheadState.slots;

// Process-wide reject counter (per key) for observability / tuning.
const rejects = bulkheadState.rejects;

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
