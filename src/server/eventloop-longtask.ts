// Event-loop long-task detector + attribution.
//
// WHY: api-primary pods pin under bursts because the single Node JS thread
// saturates. A V8 CPU profile (src/server/cpu-profiler.ts) shows where CPU is
// spent but is idle-diluted and can't show *per-task blocking frequency* — i.e.
// "operation X blocked the loop for Y ms, N times/min". This module produces
// that frequency-weighted signal directly.
//
// TIERS (cheapest first; each tier ADDS to the ones below it):
//
//   DISARMED (EVENTLOOP_LONGTASK_THRESHOLD_MS unset/<=0): the production
//     default. NOTHING is installed and — critically — the request hot path
//     (tRPC middleware, /api/v1/images) runs with NO wrapper, NO extra closure,
//     NO microtask hop. It is byte-for-byte the pre-instrumentation code path.
//     The call sites branch on `longTaskLabelsArmed` (resolved once at module
//     load) so the disarmed call is the original `return next()` / handler call.
//
//   BASE ARMED (THRESHOLD_MS > 0): cheap + safe, the intended steady-state prod
//     mode. Installs:
//       1. monitorEventLoopDelay() — a libuv-internal lag histogram. Effectively
//          zero JS overhead (no per-event callback; timing happens in C++).
//          This is the AUTHORITATIVE lag signal. Exposed as Prometheus gauges.
//       2. A timer-drift long-task detector — one repeating timer expected to
//          fire every TICK_MS. When the actual gap exceeds TICK_MS + threshold,
//          the loop was blocked for ~(gap - TICK_MS). Increments a Prom
//          histogram + counter + (rate-limited) structured log. Cost is one
//          Date.now() subtraction per tick. Blocks are labeled 'unlabeled'.
//       NOTE: base armed does NOT touch async_hooks at all — no ALS, no
//       createHook. This is deliberate: per-request async-context propagation is
//       the exact cost the team removed from OTEL (Redis/Prisma instrumentation,
//       see instrumentation.node.ts) to stop the pins. We do not re-add it as a
//       default.
//
//   LABELS (EVENTLOOP_LONGTASK_LABELS=true, requires armed): per-procedure
//     attribution via AsyncLocalStorage + async_hooks. Handlers set a short label
//     (tRPC procedure path / API route) via runWithLongTaskLabel, which opens an
//     ALS scope. An async_hooks hook then attributes blocks from WITHIN the
//     blocking resource's own execution (the `blocked-at` technique):
//       - init(asyncId): runs synchronously in the CREATING (request) context, so
//         AsyncLocalStorage.getStore() yields the request's label there. We capture
//         label_by_asyncId[asyncId] = currentLabel() at resource-creation time.
//       - before(asyncId): record start = now.
//       - after(asyncId): dur = now - start; if dur >= threshold, the callback that
//         just ran blocked the loop for `dur` => record a labeled block attributed
//         to label_by_asyncId[asyncId]. before/after bracket the EXACT synchronous
//         body, so the duration and the blamed resource are both correct.
//       - destroy(asyncId): drop the asyncId from the maps.
//     WHY NOT read ALS from the drift timer (the bug that shipped in #2451):
//       AsyncLocalStorage does NOT propagate into a pre-existing timer's callbacks.
//       The drift setInterval runs in the timer's OWN async context, never inside a
//       request's labelStorage.run() scope, so labelStorage.getStore() there is
//       always undefined => every block emitted `label="unlabeled"`. You cannot
//       attribute a block by reading ALS from a separate timer after the block ends;
//       attribution must come from the resource's own init/before/after bracket.
//     COST: this re-adds per-resource async_hooks work (init/before/after/destroy on
//     every async resource while armed) — the OTEL-class cost the team removed. It is
//     intrinsic to correct attribution. LABELS is a SHORT measurement-window tool
//     (canary-gated), NOT a steady-state default at 1500 req/s. The drift timer keeps
//     emitting its own loop-level `label="unlabeled"` blocks (GC-inclusive); the
//     async_hooks path adds the per-resource `label="trpc:*"` series alongside it.
//
//   STACKS (EVENTLOOP_LONGTASK_STACKS=true, requires armed): async_hooks stack
//     capture (most expensive). Records a captured Error().stack on sampled
//     async resources; on a block the just-finished resource's stack is the
//     blocker (the `blocked-at` technique). Sampled (~1/STACK_SAMPLE) to bound
//     cost. For short, deliberate diagnostic windows only.
//
// Server-side (nodejs runtime) only. Never imported on the edge/client.

import { AsyncLocalStorage, createHook, type AsyncHook } from 'node:async_hooks';
import { monitorEventLoopDelay, performance, type IntervalHistogram } from 'node:perf_hooks';
import client from 'prom-client';
import { instrumentationRegistry, registerInstrumentationMetric } from '~/server/prom/client';
import { logToAxiom } from '~/server/logging/client';

// Prefix mirrors prom/client.ts's PROM_PREFIX so series names match the rest of the
// app (civitai_app_*). We register these into the cross-graph `instrumentationRegistry`
// (NOT the default per-graph `client.register`) because the detector's setInterval and
// the delay gauge's collect() run in the instrumentation webpack graph, while /metrics
// scrapes from the request graph — see the long WHY note on instrumentationRegistry.
const PROM_PREFIX = 'civitai_app_';

// ---------------------------------------------------------------------------
// Config (env-tunable)
// ---------------------------------------------------------------------------

/** Block threshold in ms. <=0 or unset => the whole detector is DISARMED. */
function resolveThresholdMs(): number {
  const parsed = Number.parseInt(process.env.EVENTLOOP_LONGTASK_THRESHOLD_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * How often the drift-detection timer fires. The loop is sampled at this
 * granularity, so a block shorter than ~TICK_MS may be missed and a block is
 * resolved to within +/-TICK_MS. 20ms is a good balance: fine enough to catch a
 * 50ms block, coarse enough that the timer itself is negligible.
 */
function resolveTickMs(): number {
  const parsed = Number.parseInt(process.env.EVENTLOOP_LONGTASK_TICK_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 5 ? parsed : 20;
}

/** Max structured log lines per minute, so a storm of blocks can't flood logs/loop. */
function resolveLogPerMin(): number {
  const parsed = Number.parseInt(process.env.EVENTLOOP_LONGTASK_LOG_PER_MIN ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30;
}

/** Only LOG blocks at/above this ms (metrics still count everything >= threshold). */
function resolveLogMinMs(threshold: number): number {
  const parsed = Number.parseInt(process.env.EVENTLOOP_LONGTASK_LOG_MIN_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : threshold;
}

/**
 * OPT-IN per-procedure ALS label attribution. Requires the detector to be armed.
 * Adds an AsyncLocalStorage .run() per armed request (async_hooks context
 * propagation) — the same structural cost removed from OTEL. Off by default.
 */
function resolveLabelsEnabled(): boolean {
  return process.env.EVENTLOOP_LONGTASK_LABELS === 'true';
}

/**
 * OPT-IN async_hooks stack-capture attribution (most expensive). Requires armed
 * AND EVENTLOOP_LONGTASK_STACKS=true. Sampled: capture a stack on ~1/STACK_SAMPLE
 * async resources (1 => every resource; 50 => ~2%). Higher = cheaper + lossier.
 */
function resolveStacksEnabled(): boolean {
  return process.env.EVENTLOOP_LONGTASK_STACKS === 'true';
}
function resolveStackSample(): number {
  const parsed = Number.parseInt(process.env.EVENTLOOP_LONGTASK_STACK_SAMPLE ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 50;
}

/**
 * Gaps longer than this are treated as process suspension (GC can't pause this
 * long; this is pod CPU-steal, VM suspend, or a descheduled container), NOT a JS
 * block — so a descheduled pod doesn't emit a fake multi-second "block". The
 * authoritative lag signal remains the monitorEventLoopDelay histogram. Tunable
 * via EVENTLOOP_LONGTASK_SUSPEND_MS; <=0 disables the cap.
 */
function resolveSuspendCapMs(): number {
  const parsed = Number.parseInt(process.env.EVENTLOOP_LONGTASK_SUSPEND_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000;
}

/** Hard cap on the per-asyncId stack Map (stacks tier) so it can't grow unbounded. */
function resolveStackMapCap(): number {
  const parsed = Number.parseInt(process.env.EVENTLOOP_LONGTASK_STACK_MAP_CAP ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 100 ? parsed : 10_000;
}

/**
 * Hard cap on the per-asyncId label Map (labels tier) so it can't grow unbounded.
 * `destroy` is not guaranteed to fire for every resource, so the Map is also
 * eviction-bounded (oldest-first) on insert — see installLabelHook.
 */
function resolveLabelMapCap(): number {
  const parsed = Number.parseInt(process.env.EVENTLOOP_LONGTASK_LABEL_MAP_CAP ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 100 ? parsed : 50_000;
}

function resolvePodName(): string {
  return process.env.PODNAME || process.env.HOSTNAME || 'unknown';
}

// ---------------------------------------------------------------------------
// Module-load tier resolution
// ---------------------------------------------------------------------------

// `armed` and `labelsArmed` are settled ONCE at module load. registerEventLoop...
// runs at instrumentation time, before any request is served, so the request
// hot path can branch on these constants with zero per-request indirection.

/** True when the detector base tier is armed (THRESHOLD_MS > 0). */
let armed = false;

/**
 * True when per-procedure ALS label attribution is active (armed AND
 * EVENTLOOP_LONGTASK_LABELS=true). The tRPC middleware and /api/v1/images handler
 * import this and branch on it so the DISARMED (and base-armed-without-labels)
 * path runs the original code with NO wrapper/closure/microtask hop.
 */
export let longTaskLabelsArmed = false;

// ---------------------------------------------------------------------------
// AsyncLocalStorage attribution label (labels tier)
// ---------------------------------------------------------------------------

type LabelStore = { label: string };
const labelStorage = new AsyncLocalStorage<LabelStore>();

/**
 * Run `fn` with `label` as the active long-task attribution label.
 *
 * IMPORTANT: callers MUST gate this with `longTaskLabelsArmed` so the disarmed
 * path is wrapper-free:
 *
 *   return longTaskLabelsArmed ? runWithLongTaskLabel(path, () => next()) : next();
 *
 * As a defense-in-depth safeguard this also short-circuits internally when the
 * labels tier is not armed (then it's a direct `fn()` with no ALS store created),
 * but the call-site gate is what guarantees zero added closure when disarmed.
 */
export function runWithLongTaskLabel<T>(label: string, fn: () => T): T {
  if (!longTaskLabelsArmed) return fn();
  return labelStorage.run({ label }, fn);
}

/**
 * Current attribution label, or 'unlabeled' when running outside a labeled scope.
 *
 * IMPORTANT: this MUST only be read from a context that inherits the request's ALS
 * scope. That holds inside an async_hooks `init` callback (which runs synchronously
 * in the resource's CREATING context — see installLabelHook), and inside a handler's
 * own runWithLongTaskLabel `fn`. It does NOT hold inside the drift setInterval
 * callback (the timer's own async context, outside any request scope) — reading it
 * there always returns 'unlabeled'. That mis-read is the exact bug that shipped in
 * #2451, which is why the drift timer no longer calls this for attribution.
 */
function currentLabel(): string {
  if (!longTaskLabelsArmed) return 'unlabeled';
  return labelStorage.getStore()?.label ?? 'unlabeled';
}

// ---------------------------------------------------------------------------
// async_hooks label attribution (labels tier — opt-in, capped)
// ---------------------------------------------------------------------------

let labelHook: AsyncHook | undefined;

/**
 * The per-resource attribution state machine, factored out of the async_hooks
 * wiring so it's deterministically unit-testable WITHOUT a real async resource or
 * the OS scheduler. installLabelHook drives these from createHook; a test drives
 * them directly (init -> before -> after) to assert labeled attribution + bounding.
 *
 *   init(asyncId, label): label is captured at creation (request) context.
 *   before(asyncId, now): start the clock for this resource's callback.
 *   after(asyncId, now):  dur = now - start; if dur >= threshold, the callback that
 *                         just ran blocked the loop -> record a labeled block.
 *   destroy(asyncId):     drop the asyncId from both maps.
 *
 * `labelMapSize` is exposed for the bounding test.
 */
export type LabelAttributor = {
  init: (asyncId: number, label: string) => void;
  before: (asyncId: number, now: number) => void;
  after: (asyncId: number, now: number) => void;
  destroy: (asyncId: number) => void;
  labelMapSize: () => number;
};

export function createLabelAttributor(
  threshold: number,
  mapCap: number,
  opts: {
    logMinMs: number;
    logPerMin: number;
    // Gaps >= this are treated as process suspension (CPU-steal/VM suspend), NOT a JS
    // block, and skipped — mirrors the drift path's suspension cap. <=0 disables.
    suspendCapMs?: number;
    // Called when a started-but-not-finished (active) entry is evicted to stay under
    // the cap, so the silent loss of its labeled block is observable. Optional so the
    // pure attributor stays usable in tests without the prom counter.
    onEvictActive?: () => void;
  },
  record: (
    blockedMs: number,
    label: string,
    o: { logMinMs: number; threshold: number; logPerMin: number }
  ) => void = recordLabeledBlock
): LabelAttributor {
  // asyncId -> attribution label, captured at resource creation. HARD-CAPPED: like
  // the stacks-tier Map, `destroy` is not guaranteed for every resource, so without
  // a cap this could grow unbounded under sustained load.
  const labels = new Map<number, string>();
  // asyncId -> start timestamp recorded in `before`, consumed in `after`. Bounded by
  // the same destroy + the natural before/after pairing (deleted on `after`).
  const starts = new Map<number, number>();
  const suspendCapMs = opts.suspendCapMs ?? 0;

  // Evict to stay under the cap, PREFERRING inactive entries (no pending `before`).
  // An active entry (already `before`, awaiting `after`) that gets evicted would make
  // its `after` early-return → its block is silently dropped from the labeled series.
  // So we first sweep oldest-first for an inactive victim; only if every remaining
  // entry is active do we fall back to evicting the oldest active one (and count it),
  // which bounds memory without an unbounded scan per insert in the common case.
  function evictOne(): void {
    for (const id of labels.keys()) {
      if (!starts.has(id)) {
        labels.delete(id);
        return;
      }
    }
    // All entries are active — evict the oldest and record the loss.
    const oldest = labels.keys().next().value;
    if (oldest === undefined) return;
    labels.delete(oldest);
    starts.delete(oldest);
    opts.onEvictActive?.();
  }

  return {
    init(asyncId, label) {
      // Only track resources that carry a real (non-'unlabeled') label, so the Map
      // stays small and only spans request-scoped work.
      if (label === 'unlabeled') return;
      while (labels.size >= mapCap) evictOne();
      labels.set(asyncId, label);
    },
    before(asyncId, now) {
      if (!labels.has(asyncId)) return;
      starts.set(asyncId, now);
    },
    after(asyncId, now) {
      const start = starts.get(asyncId);
      if (start === undefined) return;
      starts.delete(asyncId);
      const label = labels.get(asyncId);
      if (label === undefined) return;
      // before/after bracket the EXACT synchronous body of this resource's callback.
      const dur = now - start;
      // Suspension guard (mirrors the drift path): a callback spanning a VM-suspend /
      // CPU-steal window isn't a real JS block — skip it instead of logging a fake
      // multi-second trpc:* block. The drift path's own suspension counter already
      // surfaces the suspension; the labeled view simply omits it.
      if (suspendCapMs > 0 && dur >= suspendCapMs) return;
      if (dur >= threshold) {
        record(dur, label, { logMinMs: opts.logMinMs, threshold, logPerMin: opts.logPerMin });
      }
    },
    destroy(asyncId) {
      labels.delete(asyncId);
      starts.delete(asyncId);
    },
    labelMapSize: () => labels.size,
  };
}

/**
 * Install the per-resource label-attribution hook (labels tier). This is the
 * CORRECT attribution path: it blames the resource whose own synchronous callback
 * blocked the loop, with the label captured at the resource's creation (request)
 * context. See the LABELS tier note at the top of the file for the full rationale
 * and the #2451 bug it replaces.
 *
 * @param threshold   block threshold in ms (same as the drift detector's)
 * @param mapCap      hard cap on the asyncId->label Map (eviction-bounded)
 * @param opts        logMinMs/logPerMin + suspendCapMs (mirrors the drift suspension
 *                    cap) so a callback spanning a suspend window isn't a fake block
 */
function installLabelHook(
  threshold: number,
  mapCap: number,
  opts: { logMinMs: number; logPerMin: number; suspendCapMs: number }
): void {
  const attr = createLabelAttributor(threshold, mapCap, {
    ...opts,
    onEvictActive: () => labeledEvictedCounter.inc(),
  });
  labelHook = createHook({
    init(asyncId: number) {
      // Runs synchronously in the CREATING context, which is INSIDE the request's
      // labelStorage.run() scope — so getStore() yields the request's label here.
      attr.init(asyncId, currentLabel());
    },
    before(asyncId: number) {
      attr.before(asyncId, performance.now());
    },
    after(asyncId: number) {
      attr.after(asyncId, performance.now());
    },
    destroy(asyncId: number) {
      attr.destroy(asyncId);
    },
  });
  labelHook.enable();
}

// ---------------------------------------------------------------------------
// async_hooks stack capture (stacks tier — opt-in, sampled, capped)
// ---------------------------------------------------------------------------

// Most-recently-entered async resource's captured stack (or undefined if that
// resource wasn't sampled). Read on a detected block: the resource that just ran
// `before` is the one whose synchronous body blocked the loop.
let lastBeforeStack: string | undefined;
let lastBeforeType: string | undefined;
let stackHook: AsyncHook | undefined;

function installStackHook(sampleEvery: number, mapCap: number): void {
  // Per-resource captured stack, keyed by asyncId. Sampled to bound capture cost,
  // and HARD-CAPPED in size: `destroy` is not guaranteed to fire for every
  // sampled resource (some resources never emit destroy), so without a cap the
  // Map could grow without bound under sustained load and leak memory. On reaching
  // the cap we evict the oldest insertion (Map preserves insertion order), which
  // bounds memory while keeping the most recent — most likely to be `before`-read
  // — stacks.
  const stacks = new Map<number, { stack: string; type: string }>();
  let counter = 0;

  stackHook = createHook({
    init(asyncId: number, type: string) {
      // Sample: only capture a stack for ~1/sampleEvery resources.
      counter = (counter + 1) % sampleEvery;
      if (counter !== 0) return;
      // Error().stack is the dominant cost; this is why the whole tier is gated.
      const stack = new Error().stack;
      if (!stack) return;
      // Bound the Map: evict oldest entries until under the cap before inserting.
      while (stacks.size >= mapCap) {
        const oldest = stacks.keys().next().value;
        if (oldest === undefined) break;
        stacks.delete(oldest);
      }
      stacks.set(asyncId, { stack, type });
    },
    before(asyncId: number) {
      const entry = stacks.get(asyncId);
      if (entry) {
        lastBeforeStack = entry.stack;
        lastBeforeType = entry.type;
      }
    },
    destroy(asyncId: number) {
      stacks.delete(asyncId);
    },
  });
  stackHook.enable();
}

// ---------------------------------------------------------------------------
// Prometheus metrics (registered via the existing prom/client helpers)
// ---------------------------------------------------------------------------

// Long-task duration histogram, labeled by attributed operation. Cardinality is
// bounded: in base-armed mode every block is 'unlabeled' (one series); with the
// labels tier on, `label` is the same fixed tRPC-procedure / route enum that
// trpc_procedure_duration already uses. Buckets target the 50ms..several-seconds
// range that matters for pins.
const longTaskHistogram = registerInstrumentationMetric(
  PROM_PREFIX + 'eventloop_longtask_duration_seconds',
  () =>
    new client.Histogram({
      name: PROM_PREFIX + 'eventloop_longtask_duration_seconds',
      help: 'Synchronous event-loop blocks over threshold, by attributed operation label. NOTE: drift-timer based — counts include GC pauses and (below the suspension cap) brief CPU-steal, not only JS blocks. The authoritative lag signal is civitai_app_eventloop_delay_ms.',
      labelNames: ['label'] as const,
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
      // Register into the shared cross-graph registry instead of the default
      // (per-graph) globalRegistry, so the request-graph /metrics scrape sees the
      // observes made from the instrumentation-graph detector loop.
      registers: [instrumentationRegistry],
    })
);

// Cheap always-armed count of detected long tasks (no label) — a single series
// that's safe to alert on even if label cardinality is ever a concern.
const longTaskCounter = registerInstrumentationMetric(
  PROM_PREFIX + 'eventloop_longtask_total',
  () =>
    new client.Counter({
      name: PROM_PREFIX + 'eventloop_longtask_total',
      help: 'Total event-loop blocks detected over threshold (drift-timer based; includes GC pauses)',
      registers: [instrumentationRegistry],
    })
);

// Count of gaps classified as process suspension (over the suspension cap) and
// therefore NOT recorded as JS blocks — surfaces pod CPU-steal / VM suspend.
const suspensionCounter = registerInstrumentationMetric(
  PROM_PREFIX + 'eventloop_longtask_suspension_total',
  () =>
    new client.Counter({
      name: PROM_PREFIX + 'eventloop_longtask_suspension_total',
      help: 'Drift-timer gaps over the suspension cap, treated as process suspension (CPU-steal/VM suspend), not JS blocks',
      registers: [instrumentationRegistry],
    })
);

// ---------------------------------------------------------------------------
// Labeled (async_hooks) attribution metrics — SEPARATE from the drift metrics
// ---------------------------------------------------------------------------
//
// These are a DISTINCT attribution VIEW from the loop-level drift metrics above,
// emitted ONLY by the async_hooks label hook (recordLabeledBlock) while the LABELS
// tier is armed. They are deliberately their OWN series — NOT the drift
// counter/histogram — so a single physical block is never counted twice:
//
//   - eventloop_longtask_total / _duration_seconds (drift): loop-level, always
//     'unlabeled', counted exactly once per detected gap by the drift timer. Valid
//     to alert on regardless of tier; never inflated by the labeled path.
//   - eventloop_longtask_labeled_total / _labeled_duration_seconds{label}: per-
//     resource attribution. Answers "which routes contributed long single-callback
//     blocks", NOT an accounting of total blocked time. It does NOT sum to the
//     loop-level total: it omits GC/unlabeled blocks, may miss blocks made of many
//     sub-threshold callbacks, and (since it's per-resource) sum by(label) can both
//     under- and over-shoot wall-clock. Treat it as a ranking signal, not a budget.
const labeledHistogram = registerInstrumentationMetric(
  PROM_PREFIX + 'eventloop_longtask_labeled_duration_seconds',
  () =>
    new client.Histogram({
      name: PROM_PREFIX + 'eventloop_longtask_labeled_duration_seconds',
      help: 'Per-resource (async_hooks-attributed) synchronous event-loop blocks over threshold, by tRPC-procedure/route label. SEPARATE attribution view — only present when EVENTLOOP_LONGTASK_LABELS is armed. Does NOT sum to eventloop_longtask_duration_seconds (the loop-level drift total); it is "which routes contributed long single-callback blocks", not total blocked time.',
      labelNames: ['label'] as const,
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
      registers: [instrumentationRegistry],
    })
);

const labeledCounter = registerInstrumentationMetric(
  PROM_PREFIX + 'eventloop_longtask_labeled_total',
  () =>
    new client.Counter({
      name: PROM_PREFIX + 'eventloop_longtask_labeled_total',
      help: 'Total per-resource (async_hooks-attributed) event-loop blocks over threshold, by label. SEPARATE from eventloop_longtask_total (the drift total) — counts the labeled attribution view only, present when EVENTLOOP_LONGTASK_LABELS is armed.',
      labelNames: ['label'] as const,
      registers: [instrumentationRegistry],
    })
);

// Count of asyncId->label entries evicted from the bounded map while still active
// (had a pending `before` with no `after`). Each eviction silently drops one
// potential labeled block from the labeled series — the drift path still catches it
// as 'unlabeled', but this counter makes the loss in the LABELED view observable.
const labeledEvictedCounter = registerInstrumentationMetric(
  PROM_PREFIX + 'eventloop_longtask_labeled_evicted_total',
  () =>
    new client.Counter({
      name: PROM_PREFIX + 'eventloop_longtask_labeled_evicted_total',
      help: 'Active (started-but-not-finished) asyncId->label entries evicted from the bounded label map, whose labeled block is consequently lost from the labeled series (still counted as unlabeled by the drift path).',
      registers: [instrumentationRegistry],
    })
);

// monitorEventLoopDelay() histogram, surfaced as collect()-based gauges (matching
// the pg-pool gauge pattern in prom/client.ts). Reset after each scrape so each
// scrape reflects the interval since the last one (Prometheus-friendly).
let elDelayHistogram: IntervalHistogram | undefined;
let elGaugeInitialized = false;

function initEventLoopDelayGauges(): void {
  if (elGaugeInitialized) return;
  elGaugeInitialized = true;

  elDelayHistogram = monitorEventLoopDelay({ resolution: 10 });
  elDelayHistogram.enable();

  // One labeled gauge emitting p50/p99/max/mean (ms). collect() reads the live
  // libuv histogram on each scrape — no per-event JS work.
  //
  // Registered directly into the cross-graph shared `instrumentationRegistry` (via
  // `registers: [instrumentationRegistry]` below) instead of the default per-graph
  // globalRegistry. registerInstrumentationMetric is the idempotent get-or-create
  // guard (safe under HMR / dual-graph eval). The collect() hook fires when that
  // shared registry is scraped, which /metrics reads in explicitly by
  // string-concatenating its output (NOT Registry.merge — so it can't throw on a
  // name clash).
  registerInstrumentationMetric(
    PROM_PREFIX + 'eventloop_delay_ms',
    () =>
      new client.Gauge({
        name: PROM_PREFIX + 'eventloop_delay_ms',
        help: 'Event-loop delay (lag) distribution from perf_hooks.monitorEventLoopDelay, ms. This is the AUTHORITATIVE event-loop lag signal (C++ measured, no JS per-event cost).',
        labelNames: ['quantile'],
        // Register into the shared cross-graph registry (NOT the default per-graph
        // globalRegistry) so the collect() hook fires when /metrics reads it in.
        registers: [instrumentationRegistry],
        collect() {
          const h = elDelayHistogram;
          if (!h) return;
          const toMs = (ns: number) => (Number.isFinite(ns) ? ns / 1e6 : 0);
          this.set({ quantile: 'p50' }, toMs(h.percentile(50)));
          this.set({ quantile: 'p90' }, toMs(h.percentile(90)));
          this.set({ quantile: 'p99' }, toMs(h.percentile(99)));
          this.set({ quantile: 'max' }, toMs(h.max));
          this.set({ quantile: 'mean' }, toMs(h.mean));
          // Reset so the next scrape window is independent (avoids max/p99 sticking
          // at an all-time high forever after a single spike).
          h.reset();
        },
      })
  );
}

// ---------------------------------------------------------------------------
// Rate-limited structured logging
// ---------------------------------------------------------------------------

let logBudget = 0;
let logWindowStart = 0;
let droppedSinceLastLog = 0;

function tryLog(durationMs: number, label: string, threshold: number, logPerMin: number): void {
  const now = Date.now();
  // Refill the per-minute budget.
  if (now - logWindowStart >= 60_000) {
    logWindowStart = now;
    logBudget = logPerMin;
  }
  if (logBudget <= 0) {
    droppedSinceLastLog++;
    return;
  }
  logBudget--;

  const dropped = droppedSinceLastLog;
  droppedSinceLastLog = 0;

  // logToAxiom is fire-and-forget (async); never await it on this path.
  void logToAxiom(
    {
      name: 'eventloop-longtask',
      pod: resolvePodName(),
      durationMs: Math.round(durationMs),
      thresholdMs: threshold,
      label,
      // Stack is only present when the stacks tier is enabled AND this resource
      // was sampled.
      stack: lastBeforeStack,
      resourceType: lastBeforeType,
      // How many blocks were suppressed by the rate-limiter since the last logged
      // line — so a storm is visible in the data without flooding.
      droppedSinceLastLog: dropped,
    },
    'eventloop-longtask'
  ).catch(() => {
    // Logging must never crash or block the detector.
  });
}

// ---------------------------------------------------------------------------
// Drift math (pure, unit-testable)
// ---------------------------------------------------------------------------

export type DriftClassification =
  | { kind: 'ok'; blockedMs: number }
  | { kind: 'block'; blockedMs: number }
  | { kind: 'suspension'; gapMs: number };

/**
 * Classify a single drift-timer tick. Pure function so the math is unit-testable
 * without timers.
 *
 * @param nowMs        timestamp of this tick
 * @param lastMs       timestamp of the previous tick
 * @param tickMs       expected interval between ticks
 * @param thresholdMs  block threshold (excess over tickMs)
 * @param suspendCapMs gaps with excess >= this are process suspension, not a JS
 *                     block (<=0 disables the cap)
 *
 * NOTE: blockedMs from a JS setInterval includes GC pauses and brief pod
 * CPU-steal — it is NOT a pure "JS executed synchronously for N ms" signal. The
 * authoritative lag signal is the monitorEventLoopDelay histogram. The suspension
 * cap filters out absurd gaps (descheduled pod / VM suspend) so they aren't
 * recorded as multi-second JS blocks.
 */
export function classifyDrift(
  nowMs: number,
  lastMs: number,
  tickMs: number,
  thresholdMs: number,
  suspendCapMs: number
): DriftClassification {
  const blockedMs = nowMs - lastMs - tickMs;
  if (blockedMs < thresholdMs) return { kind: 'ok', blockedMs };
  if (suspendCapMs > 0 && blockedMs >= suspendCapMs) {
    return { kind: 'suspension', gapMs: nowMs - lastMs };
  }
  return { kind: 'block', blockedMs };
}

/**
 * Apply a classified drift result to the Prometheus metrics (and, for blocks over
 * the log floor, the rate-limited structured log). This is the bridge from the
 * detector's setInterval to the REGISTERED metric instances — the path that was
 * silently broken when the metrics were registered in a different (per-graph)
 * registry than the one /metrics scrapes. Exported so a unit test can assert it
 * actually increments/observes the registered metric without a real timer.
 *
 * Returns the resolved attribution label (or undefined for non-block results) to
 * make the test assertions explicit; the timer ignores the return.
 *
 * ATTRIBUTION: drift-timer blocks are ALWAYS recorded as 'unlabeled'. The timer runs
 * in its own async context (NOT a request's ALS scope), so it cannot know which
 * request blocked the loop — reading currentLabel() here always yielded 'unlabeled'
 * AND was the #2451 bug (it implied attribution that never worked). Per-procedure
 * attribution is emitted separately by the async_hooks label hook (recordLabeledBlock),
 * which blames the resource from within its own execution.
 */
export function recordDrift(
  result: DriftClassification,
  opts: { logMinMs: number; threshold: number; logPerMin: number }
): string | undefined {
  if (result.kind === 'suspension') {
    // Descheduled pod / VM suspend / CPU-steal — NOT a JS block. Count it
    // separately and skip the block histogram + log so we don't emit a fake
    // multi-second block.
    suspensionCounter.inc();
    return undefined;
  }
  if (result.kind === 'block') {
    const { blockedMs } = result;
    // Loop-level drift is unattributable from the timer context — see the note above.
    const label = 'unlabeled';
    longTaskCounter.inc();
    longTaskHistogram.observe({ label }, blockedMs / 1000);
    if (blockedMs >= opts.logMinMs) {
      tryLog(blockedMs, label, opts.threshold, opts.logPerMin);
    }
    return label;
  }
  return undefined;
}

/**
 * Record a per-procedure (async_hooks-attributed) labeled block. Called from the
 * label hook's `after` when a resource's own callback blocked the loop for
 * >= threshold, with the real attribution label (e.g. 'trpc:image.getInfinite')
 * captured at the resource's creation context — NOT 'unlabeled'. Exported so a unit
 * test can assert the attribution without a real async resource.
 *
 * IMPORTANT (double-counting fix): this writes to the DEDICATED labeled metrics
 * (eventloop_longtask_labeled_total / _labeled_duration_seconds), NOT the drift
 * metrics (longTaskCounter / longTaskHistogram). The drift timer already counts every
 * physical gap once as 'unlabeled'; if this path also touched the drift metrics, a
 * single 200ms block would be counted twice (_total +2, _sum ~2x), inflating the
 * loop-level totals and letting sum by(label) exceed 100% of wall-clock while armed.
 * Keeping the labeled series separate makes the drift totals accurate and alertable
 * regardless of tier, and the labeled series an independent attribution view.
 *
 * Cardinality: `label` is the bounded tRPC-procedure/route set the callers pass to
 * runWithLongTaskLabel — never an unbounded value. 'unlabeled' is excluded here (the
 * hook only tracks request-scoped resources) so it stays the drift timer's series.
 */
export function recordLabeledBlock(
  blockedMs: number,
  label: string,
  opts: { logMinMs: number; threshold: number; logPerMin: number }
): void {
  labeledCounter.inc({ label });
  labeledHistogram.observe({ label }, blockedMs / 1000);
  if (blockedMs >= opts.logMinMs) {
    tryLog(blockedMs, label, opts.threshold, opts.logPerMin);
  }
}

// ---------------------------------------------------------------------------
// Arm / detector loop
// ---------------------------------------------------------------------------

/**
 * Arm the event-loop long-task detector. Safe to call once at server startup.
 * No-op off the nodejs runtime and when EVENTLOOP_LONGTASK_THRESHOLD_MS <= 0
 * (the disarmed default), in which case the request hot path is left completely
 * untouched (no wrapper — see longTaskLabelsArmed and runWithLongTaskLabel).
 */
export function registerEventLoopLongTaskDetector(): void {
  try {
    if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== 'nodejs') return;
    if (armed) return;

    const threshold = resolveThresholdMs();
    if (threshold <= 0) {
      // DISARMED — the common production default. Nothing installed; the request
      // hot path runs the original code with zero added indirection.
      return;
    }

    const tickMs = resolveTickMs();
    const logPerMin = resolveLogPerMin();
    const logMinMs = resolveLogMinMs(threshold);
    const suspendCapMs = resolveSuspendCapMs();
    const labelsEnabled = resolveLabelsEnabled();
    const stacksEnabled = resolveStacksEnabled();
    const stackSample = resolveStackSample();
    const stackMapCap = resolveStackMapCap();
    const labelMapCap = resolveLabelMapCap();

    armed = true;
    // Labels tier is the ONLY thing the request hot path branches on. Set before
    // any request runs so call sites read a settled constant.
    longTaskLabelsArmed = labelsEnabled;

    // BASE ARMED: always-on lag histogram (cheap, C++-measured). NO async_hooks.
    initEventLoopDelayGauges();

    // LABELS tier: opt-in, capped async_hooks per-resource attribution. This is the
    // CORRECT label path (init/before/after bracket the blocking resource's own body)
    // and the only thing that emits `label="trpc:*"` blocks. Re-adds per-resource
    // async_hooks cost — short measurement-window / canary tool, NOT a steady-state
    // default. Installed ONLY when labels are enabled; base-armed touches no async_hooks.
    if (labelsEnabled) {
      installLabelHook(threshold, labelMapCap, { logMinMs, logPerMin, suspendCapMs });
    }

    // STACKS tier: opt-in, sampled, capped async_hooks stack attribution (expensive).
    if (stacksEnabled) {
      installStackHook(stackSample, stackMapCap);
    }

    // Drift-detection timer. Expected gap is tickMs; anything beyond
    // tickMs + threshold means the loop was synchronously blocked for the excess
    // (subject to the suspension cap, which reclassifies absurd gaps).
    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      const result = classifyDrift(now, last, tickMs, threshold, suspendCapMs);
      last = now;

      recordDrift(result, { logMinMs, threshold, logPerMin });

      // Clear the sampled stack after each tick so a stale stack from a previous
      // tick can't be mis-attributed to a later block. Cheap no-op when stacks
      // tier is off.
      lastBeforeStack = undefined;
      lastBeforeType = undefined;
    }, tickMs);

    // Don't keep the process alive solely for this timer (e.g. during shutdown).
    timer.unref();

    // eslint-disable-next-line no-console
    console.log(
      `[eventloop-longtask] armed: threshold=${threshold}ms tick=${tickMs}ms ` +
        `logPerMin=${logPerMin} logMinMs=${logMinMs} suspendCap=${suspendCapMs}ms ` +
        `labels=${labelsEnabled ? `on(cap=${labelMapCap})` : 'off'} ` +
        `stacks=${stacksEnabled ? `on(sample=1/${stackSample},cap=${stackMapCap})` : 'off'}`
    );
  } catch (err) {
    // Arm-time failure must never take down instrumentation/boot.
    // eslint-disable-next-line no-console
    console.error('[eventloop-longtask] failed to arm; continuing without it:', err);
  }
}

// ---------------------------------------------------------------------------
// Test-only hooks (not for production use)
// ---------------------------------------------------------------------------

/**
 * Test-only: force the labels-armed flag. Returns a restore fn. Lets the unit
 * tests assert the disarmed passthrough without booting the whole detector or
 * relying on env at import time.
 */
export function __setLongTaskLabelsArmedForTests(value: boolean): () => void {
  const prev = longTaskLabelsArmed;
  longTaskLabelsArmed = value;
  return () => {
    longTaskLabelsArmed = prev;
  };
}

/** Test-only: observe whether the ALS store is currently set (proves no .run()). */
export function __hasActiveLabelStoreForTests(): boolean {
  return labelStorage.getStore() !== undefined;
}

/**
 * Test-only: run the base-armed gauge init (monitorEventLoopDelay + the
 * civitai_app_eventloop_delay_ms collect()-gauge) so a test can assert the gauge is
 * registered in the scraped (instrumentation) registry without booting the whole
 * detector via env. Idempotent — mirrors the base-armed init path.
 */
export function __initEventLoopDelayGaugesForTests(): void {
  initEventLoopDelayGauges();
}

/**
 * Test-only: install the REAL async_hooks label hook and return a teardown fn. Lets
 * an integration test drive a real async resource created inside runWithLongTaskLabel
 * and assert the resulting block attributes to the request's label (the exact #2451
 * failure) — wired to a custom `record` sink so the test can capture the emission
 * without the prom registry. Mirrors the production installLabelHook wiring.
 */
export function __installLabelHookForTests(
  threshold: number,
  mapCap: number,
  record: (blockedMs: number, label: string) => void,
  suspendCapMs = 0
): () => void {
  const attr = createLabelAttributor(
    threshold,
    mapCap,
    { logMinMs: threshold, logPerMin: 0, suspendCapMs },
    (blockedMs, label) => record(blockedMs, label)
  );
  const hook = createHook({
    init(asyncId: number) {
      attr.init(asyncId, currentLabel());
    },
    before(asyncId: number) {
      attr.before(asyncId, performance.now());
    },
    after(asyncId: number) {
      attr.after(asyncId, performance.now());
    },
    destroy(asyncId: number) {
      attr.destroy(asyncId);
    },
  });
  hook.enable();
  return () => hook.disable();
}
