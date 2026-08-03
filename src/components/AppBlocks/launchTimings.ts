// App Blocks — LAUNCH-LATENCY marks and the pure math that turns them into a
// beacon payload.
//
// WHY THIS IS A SEPARATE MODULE AND NOT INLINE IN PageBlockHost:
// every rule below (never-emit-a-zero, drop-don't-clamp, the hidden-tab drop,
// the host-reuse reset) is a correctness rule whose failure mode is a *plausible
// wrong number* rather than a crash. Those need node-runnable tests, and the
// browser (`component`) Vitest project is not run in CI — only the `unit`
// project is. So the math lives here, and the host only records marks.
//
// ─── The launch chain this measures ───────────────────────────────────────────
// Design: datapacket-talos
// claudedocs/app-blocks-launch-latency-instrumentation-and-preload-2026-08-02.md
//
// 🔴 THE TOKEN MINT AND THE CROSS-ORIGIN FRAME LOAD RUN IN PARALLEL.
// `showIframe` is true while `status === 'loading'`, and the initial status IS
// 'loading', so `<iframe src>` (an SSR prop, not derived from the token) mounts
// on the FIRST client render — before any token exists. The launch therefore
// waits on `max(token, block-listener-attached)`, then the BLOCK_INIT re-post
// cadence, then the block's own render-to-ready.
//
// So `token_mint + init_wait !== total`, BY CONSTRUCTION, and any consumer that
// sums the phases is reading a fiction. They are two independent legs of one
// race; `total` is the only end-to-end number.

/**
 * Code-owned phase enum. Mirrored server-side in app-block-runtime.metrics.
 *
 * 🔴 THERE IS DELIBERATELY NO CROSS-ORIGIN `frame_fetch` PHASE — see the
 * DEFERRED note at the bottom of this file. It is not an oversight, and it is
 * not cheap to add back: the quantity a naive implementation measures is not the
 * one its name would claim.
 */
export const LAUNCH_PHASES = ['token_mint', 'init_wait'] as const;
export type LaunchPhase = (typeof LAUNCH_PHASES)[number];

/**
 * Upper sanity bound on any single launch sample, in milliseconds.
 *
 * 🔴 60 s IS DERIVED FROM THE AUTO-RETRY BOUND, NOT PICKED. An earlier draft used
 * 30 s, justified as "comfortably above TOKEN_WAIT_TIMEOUT_MS (15 s), the longest
 * leg that can legitimately complete". That justification was WRONG, because a
 * successful launch is not one attempt: `MAX_AUTO_RETRIES = 2` means the host
 * emits ONE `ok` for the whole bounded sequence, whichever attempt produced it.
 * Worst reachable success:
 *
 *     15 s (attempt 1 -> no_token at TOKEN_WAIT_TIMEOUT_MS)
 *   +  2 s (AUTO_RETRY_BACKOFF_MS[0])
 *   + 15 s (attempt 2 -> no_token)
 *   +  5 s (AUTO_RETRY_BACKOFF_MS[1])
 *   + ~10 s (attempt 3 finally reaches BLOCK_READY)
 *   = ~47 s
 *
 * A 30 s cap therefore DROPPED real slow successes — and the drop was
 * slowness-correlated, i.e. it silently trimmed exactly the tail the metric
 * exists to show. 60 s clears the computed bound with margin while still
 * rejecting a clock anomaly or a `performance.now()` discontinuity.
 *
 * 🔴 DROPPED, NEVER CLAMPED — mirrors `observeCustomComfyWallclockSeconds`. A
 * clamp folds junk onto the `+Inf` edge and poisons `_sum` and every tail
 * quantile with a value that was never real.
 */
export const MAX_LAUNCH_SAMPLE_MS = 60_000;

/** Mutable per-mount marks, all `performance.now()` values. */
export type LaunchMarks = {
  /** Host mount (first client render). `null` on the server. */
  mountedAt: number | null;
  /** First non-null token — the END of the mint leg, not its start. */
  tokenAt: number | null;
  /** First BLOCK_INIT posted. */
  initSentAt: number | null;
  /** BLOCK_READY received. */
  readyAt: number | null;
  /**
   * 🔴 Sticky: true if the tab was hidden at ANY point from mount to ready.
   * A run page opened in a background tab gets throttled timers and a
   * BLOCK_READY seconds late at zero user-felt cost. Without this the p95
   * measures tab-switching, not launch.
   */
  wasHidden: boolean;
};

/** The optional `timings` object carried on the existing block-render beacon. */
export type LaunchTimingsPayload = {
  totalMs: number;
  tokenMintMs?: number;
  initWaitMs?: number;
};

export function createLaunchMarks(now: number | null, hidden: boolean): LaunchMarks {
  return { mountedAt: now, tokenAt: null, initSentAt: null, readyAt: null, wasHidden: hidden };
}

/**
 * Re-arm the marks in place for a NEW block instance. `/apps/run/[slug]` renders
 * <PageBlockHost> with no `key`, so a soft navigation between two apps REUSES
 * the component instance — app A's `mountedAt` would otherwise be attributed to
 * app B's launch. Mutates rather than replaces so callers keep a stable ref.
 */
export function resetLaunchMarks(marks: LaunchMarks, now: number | null, hidden: boolean): void {
  marks.mountedAt = now;
  marks.tokenAt = null;
  marks.initSentAt = null;
  marks.readyAt = null;
  marks.wasHidden = hidden;
}

/**
 * 🔴 MUST THE MARKS BE RE-ARMED? Only when the block INSTANCE actually changed.
 *
 * This is a named predicate rather than an inline `!==` because getting it wrong
 * is invisible. An effect keyed on `[blockInstanceId]` ALSO RUNS ON FIRST MOUNT,
 * so resetting unconditionally overwrites the render-time `mountedAt` with a
 * post-commit timestamp: nothing breaks, no test goes red, and every `total` is
 * silently short by the render->effect gap — i.e. it discards precisely the
 * hydration/first-commit window t0 exists to capture, in the flattering
 * direction.
 *
 * That gap is a few milliseconds in a test harness and much larger on a real
 * cold page load, so a browser test cannot discriminate it by magnitude. This
 * predicate is where the rule is pinned instead.
 */
export function shouldResetLaunchMarks(
  previousInstanceId: string | null,
  nextInstanceId: string
): boolean {
  return previousInstanceId !== null && previousInstanceId !== nextInstanceId;
}

/**
 * A bounded, strictly-positive millisecond delta, or `undefined`.
 *
 * 🔴 THE `> 0` IS THE "NEVER EMIT A ZERO" RULE, and it is why this is one
 * function rather than several inline subtractions. A zero is indistinguishable
 * from an instant leg, so emitting one for a leg that simply was not observed
 * drags every percentile down — silently, and in the reassuring direction.
 */
export function boundedDeltaMs(
  from: number | null | undefined,
  to: number | null | undefined
): number | undefined {
  if (typeof from !== 'number' || typeof to !== 'number') return undefined;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return undefined;
  return boundedDurationMs(to - from);
}

/** The same two gates applied to an already-computed duration. */
export function boundedDurationMs(raw: number | null | undefined): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  const ms = Math.round(raw);
  if (!(ms > 0)) return undefined;
  if (ms > MAX_LAUNCH_SAMPLE_MS) return undefined;
  return ms;
}

/**
 * `performance.now()`, or `null` where there is no clock (SSR). A `null` mark
 * propagates: `boundedDeltaMs` rejects it, so the sample is simply not reported
 * rather than being reported as a bogus delta from 0.
 */
export function nowMs(): number | null {
  try {
    if (typeof performance === 'undefined' || typeof performance.now !== 'function') return null;
    return performance.now();
  } catch {
    return null;
  }
}

/** True when the tab is currently hidden. Never throws; false outside a DOM. */
export function isDocumentHidden(): boolean {
  try {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
  } catch {
    return false;
  }
}

/**
 * Turn the marks into the beacon's `timings` object, or `null` when this launch
 * must not be observed at all.
 *
 * 🔴 RETURNS null (no sample) WHEN:
 *   - the tab was ever hidden during the launch window — throttled timers, zero
 *     user-felt cost, would measure tab-switching;
 *   - there is no `mountedAt`/`readyAt` — nothing reached BLOCK_READY, so there
 *     is no launch. (The caller additionally only ever asks on the `ok` beacon:
 *     a FAILURE beacon has no BLOCK_READY, and observing it would record the
 *     failure as a *fast* launch; a `secondary` beacon describes a teardown
 *     minutes later.)
 *   - `total` is non-positive or past `MAX_LAUNCH_SAMPLE_MS`.
 *
 * `total` is the anchor: without a credible end-to-end number the phases have
 * nothing to be interpreted against, so the whole sample is dropped rather than
 * emitting orphan phases.
 */
export function computeLaunchTimings(marks: LaunchMarks): LaunchTimingsPayload | null {
  if (marks.wasHidden) return null;

  const totalMs = boundedDeltaMs(marks.mountedAt, marks.readyAt);
  if (totalMs === undefined) return null;

  const tokenMintMs = boundedDeltaMs(marks.mountedAt, marks.tokenAt);
  const initWaitMs = boundedDeltaMs(marks.initSentAt, marks.readyAt);

  return {
    totalMs,
    ...(tokenMintMs !== undefined ? { tokenMintMs } : {}),
    ...(initWaitMs !== undefined ? { initWaitMs } : {}),
  };
}

// ─── 🔴 DEFERRED: a cross-origin `frame_fetch` phase ──────────────────────────
//
// An earlier revision of this change shipped a `frame_fetch` phase read from the
// parent's `PerformanceResourceTiming` entry for the block iframe. IT WAS
// REMOVED, and not because it needed polish — the number it produced was not the
// number its name claimed.
//
// 1. WITHOUT `Timing-Allow-Origin`, `responseEnd` FOR A CROSS-ORIGIN SUBFRAME IS
//    THE FRAME'S `load` EVENT, NOT THE DOCUMENT RESPONSE. The HTML spec's iframe
//    load steps set the fallback "response end time" to the current time when the
//    subframe's load event fires, and the TAO check is what selects between that
//    fallback and the real document timing. So the SAME field carries two
//    different quantities depending on a header we do not send: with TAO (or
//    same-origin) it is document-response completion; without, it is the whole
//    subframe load, including the block's own JS, CSS, fonts and images.
//    Measured on Chromium 144 and 150 against a child page holding one
//    subresource: the no-TAO duration tracked the delay 1:1 (657 / 2053 /
//    5066 ms for 500 / 2000 / 5000 ms held) while TAO and same-origin stayed at
//    3-9 ms. Practical effect on a real block: the phase reads close to `total`,
//    seconds not milliseconds, and visually dominates any phase panel while
//    measuring roughly what `total` already measures.
//
// 2. AND IT IS NOT 100% OBSERVABLE ANYWAY. The entry does not exist until the
//    subframe's load event fires. An SPA block that posts BLOCK_READY at
//    app-mount — the normal case, with fonts and images still in flight —
//    produces NO entry at the moment the beacon reads it, so the phase silently
//    vanishes. Heavier apps drop out more often, which makes the missing data
//    slowness-correlated: exactly the bias that makes a percentile lie in the
//    reassuring direction.
//
// Together those leave three honest options: (a) send TAO and measure the
// document response, (b) measure from inside the block via the SDK, or (c) don't
// ship the phase. This change takes (c). The `Timing-Allow-Origin` question is
// being reopened separately and is NOT merely explanatory — because the header
// changes WHICH QUANTITY the field carries, it may be a genuine prerequisite
// rather than a nice-to-have.
//
// If the phase comes back, the seam is small: add the literal to LAUNCH_PHASES
// here and to APP_BLOCK_LAUNCH_PHASES server-side, add one optional
// `frameFetchMs` number to the beacon schema, and populate it in
// `computeLaunchTimings`. Nothing else in this module is shaped around its
// absence. Whatever is added must state plainly WHICH of the two quantities it
// measures, and must publish its own coverage denominator rather than being
// quoted as a fleet number.
