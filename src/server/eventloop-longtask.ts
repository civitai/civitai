// Event-loop long-task detector + attribution.
//
// WHY: api-primary pods pin under bursts because the single Node JS thread
// saturates. A V8 CPU profile (src/server/cpu-profiler.ts) shows where CPU is
// spent but is idle-diluted and can't show *per-task blocking frequency* — i.e.
// "operation X blocked the loop for Y ms, N times/min". This module produces
// that frequency-weighted signal directly:
//
//   1. monitorEventLoopDelay()  — a libuv-internal lag histogram. Effectively
//      zero JS overhead (no per-event callback; the timing happens in C++).
//      Always-on when armed. Exposed as Prometheus gauges.
//
//   2. A timer-drift long-task detector — a single repeating timer expected to
//      fire every TICK_MS. When the actual gap exceeds TICK_MS + threshold, the
//      loop was blocked synchronously for ~(gap - TICK_MS). Increments a Prom
//      histogram + (rate-limited) structured log. One timer for the whole
//      process; the detection cost is one Date.now() subtraction per tick.
//
//   3. Attribution. Two tiers, cheapest first:
//      (a) AsyncLocalStorage label (DEFAULT, cheap): handlers set a short label
//          (tRPC procedure path / API route / webhook) via runWithLongTaskLabel.
//          On a detected block we read the CURRENTLY-RUNNING label — this names
//          the operation that was executing when the loop unblocked, with no
//          stack work. ALS context propagation is the only steady-state cost,
//          and it is incurred only inside armed handlers.
//      (b) async_hooks stack capture (OPT-IN + SAMPLED, expensive): records a
//          captured stack on each async resource's `before` hook. When a block
//          is detected, the just-finished resource's stack is the blocker (the
//          `blocked-at` npm technique). Capturing Error().stack per async
//          resource is costly, so it is gated behind its OWN env flag AND
//          sampled (only ~1/N resources capture a stack).
//
// OVERHEAD: tier (a) is the intended prod mode — a repeating timer + one
// subtraction per tick + an ALS store per armed request. Tier (b) is for short,
// deliberate diagnostic windows only and is NOT recommended steady-state on
// api-primary at 1500 req/s.
//
// Default OFF. Armed only when EVENTLOOP_LONGTASK_THRESHOLD_MS > 0.
// Server-side (nodejs runtime) only. Never imported on the edge/client.

import { AsyncLocalStorage, createHook, type AsyncHook } from 'node:async_hooks';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import client from 'prom-client';
import { registerCounter, registerHistogram } from '~/server/prom/client';
import { logToAxiom } from '~/server/logging/client';

// ---------------------------------------------------------------------------
// Config (env-tunable)
// ---------------------------------------------------------------------------

/** Block threshold in ms. <=0 or unset => the whole detector is DISABLED. */
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
 * OPT-IN async_hooks stack-capture attribution (expensive). Disabled unless
 * EVENTLOOP_LONGTASK_STACKS=true. Sampled: capture a stack on ~1/STACK_SAMPLE
 * async resources (1 => every resource; 50 => ~2%). Higher = cheaper + lossier.
 */
function resolveStacksEnabled(): boolean {
  return process.env.EVENTLOOP_LONGTASK_STACKS === 'true';
}
function resolveStackSample(): number {
  const parsed = Number.parseInt(process.env.EVENTLOOP_LONGTASK_STACK_SAMPLE ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 50;
}

function resolvePodName(): string {
  return process.env.PODNAME || process.env.HOSTNAME || 'unknown';
}

// ---------------------------------------------------------------------------
// AsyncLocalStorage attribution label (tier a)
// ---------------------------------------------------------------------------

type LabelStore = { label: string };
const labelStorage = new AsyncLocalStorage<LabelStore>();

/**
 * Run `fn` with `label` as the active long-task attribution label. Cheap: one
 * ALS store per call. Safe to call even when the detector is disabled (then it's
 * a thin passthrough — see runWithLongTaskLabel which short-circuits). Used by
 * the tRPC middleware / API-route / webhook entry points.
 */
export function runWithLongTaskLabel<T>(label: string, fn: () => T): T {
  // When disarmed, don't pay even the ALS cost.
  if (!armed) return fn();
  return labelStorage.run({ label }, fn);
}

/** Current attribution label, or 'unlabeled' when running outside a labeled scope. */
function currentLabel(): string {
  return labelStorage.getStore()?.label ?? 'unlabeled';
}

// ---------------------------------------------------------------------------
// async_hooks stack capture (tier b — opt-in, sampled)
// ---------------------------------------------------------------------------

// Most-recently-entered async resource's captured stack (or undefined if that
// resource wasn't sampled). Read on a detected block: the resource that just ran
// `before` is the one whose synchronous body blocked the loop.
let lastBeforeStack: string | undefined;
let lastBeforeType: string | undefined;
let stackHook: AsyncHook | undefined;

function installStackHook(sampleEvery: number): void {
  // Per-resource captured stack, keyed by asyncId. Sampled to bound cost.
  const stacks = new Map<number, { stack: string; type: string }>();
  let counter = 0;

  stackHook = createHook({
    init(asyncId: number, type: string) {
      // Sample: only capture a stack for ~1/sampleEvery resources.
      counter = (counter + 1) % sampleEvery;
      if (counter !== 0) return;
      // Error().stack is the dominant cost; this is why the whole tier is gated.
      const stack = new Error().stack;
      if (stack) stacks.set(asyncId, { stack, type });
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
// bounded: `label` is the same fixed tRPC-procedure / route enum that
// trpc_procedure_duration already uses (plus 'unlabeled'). Buckets target the
// 50ms..several-seconds range that matters for pins.
const longTaskHistogram = registerHistogram({
  name: 'eventloop_longtask_duration_seconds',
  help: 'Synchronous event-loop blocks over threshold, by attributed operation label',
  labelNames: ['label'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
});

// Cheap always-armed count of detected long tasks (no label) — a single series
// that's safe to alert on even if label cardinality is ever a concern.
const longTaskCounter = registerCounter({
  name: 'eventloop_longtask_total',
  help: 'Total event-loop blocks detected over threshold',
});

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
  const g = new client.Gauge({
    name: 'civitai_app_eventloop_delay_ms',
    help: 'Event-loop delay (lag) distribution from perf_hooks.monitorEventLoopDelay, ms',
    labelNames: ['quantile'],
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
  });
  // Guard against double-registration under Next.js HMR.
  try {
    client.register.registerMetric(g);
  } catch {
    // already registered
  }
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
      // Stack is only present when tier (b) is enabled AND this resource was sampled.
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
// Arm / detector loop
// ---------------------------------------------------------------------------

let armed = false;

/**
 * Arm the event-loop long-task detector. Safe to call once at server startup.
 * No-op off the nodejs runtime and when EVENTLOOP_LONGTASK_THRESHOLD_MS <= 0.
 */
export function registerEventLoopLongTaskDetector(): void {
  try {
    if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== 'nodejs') return;
    if (armed) return;

    const threshold = resolveThresholdMs();
    if (threshold <= 0) {
      // Disabled — the common production default. Zero overhead.
      return;
    }

    const tickMs = resolveTickMs();
    const logPerMin = resolveLogPerMin();
    const logMinMs = resolveLogMinMs(threshold);
    const stacksEnabled = resolveStacksEnabled();
    const stackSample = resolveStackSample();

    armed = true;

    // Always-on lag histogram (cheap).
    initEventLoopDelayGauges();

    // Opt-in, sampled stack attribution (expensive).
    if (stacksEnabled) {
      installStackHook(stackSample);
    }

    // Drift-detection timer. Expected gap is tickMs; anything beyond
    // tickMs + threshold means the loop was synchronously blocked for the excess.
    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      const blockedMs = now - last - tickMs;
      last = now;

      if (blockedMs >= threshold) {
        const label = currentLabel();
        longTaskCounter.inc();
        longTaskHistogram.observe({ label }, blockedMs / 1000);
        if (blockedMs >= logMinMs) {
          tryLog(blockedMs, label, threshold, logPerMin);
        }
      }

      // Clear the sampled stack after each tick so a stale stack from a previous
      // tick can't be mis-attributed to a later block.
      lastBeforeStack = undefined;
      lastBeforeType = undefined;
    }, tickMs);

    // Don't keep the process alive solely for this timer (e.g. during shutdown).
    timer.unref();

    // eslint-disable-next-line no-console
    console.log(
      `[eventloop-longtask] armed: threshold=${threshold}ms tick=${tickMs}ms ` +
        `logPerMin=${logPerMin} logMinMs=${logMinMs} ` +
        `stacks=${stacksEnabled ? `on(sample=1/${stackSample})` : 'off'}`
    );
  } catch (err) {
    // Arm-time failure must never take down instrumentation/boot.
    // eslint-disable-next-line no-console
    console.error('[eventloop-longtask] failed to arm; continuing without it:', err);
  }
}
