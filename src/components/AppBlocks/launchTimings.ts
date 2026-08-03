// App Blocks — LAUNCH-LATENCY marks and the pure math that turns them into a
// beacon payload.
//
// WHY THIS IS A SEPARATE MODULE AND NOT INLINE IN PageBlockHost:
// every rule below (never-emit-a-zero, drop-don't-clamp, the hidden-tab drop)
// is a correctness rule whose failure mode is a *plausible wrong number* rather
// than a crash. Those need node-runnable tests, and the browser (`component`)
// Vitest project is not run in CI — only the `unit` project is. So the math
// lives here, and the host only records marks.
//
// ─── The launch chain this measures ───────────────────────────────────────────
// Design + measurements: datapacket-talos
// claudedocs/app-blocks-launch-latency-instrumentation-and-preload-2026-08-02.md
//
// 🔴 THE TOKEN MINT AND THE CROSS-ORIGIN FRAME LOAD RUN IN PARALLEL.
// `showIframe` is true while `status === 'loading'`, and the initial status IS
// 'loading', so `<iframe src>` (an SSR prop, not derived from the token) mounts
// on the FIRST client render — before any token exists. The launch therefore
// waits on `max(token, block-listener-attached)`, then the BLOCK_INIT re-post
// cadence, then the block's own render-to-ready.
//
// So `token_mint + frame_fetch + init_wait !== total`, BY CONSTRUCTION, and any
// consumer that sums the phases is reading a fiction. They are three
// independent legs of one race; `total` is the only end-to-end number.

/** Code-owned phase enum. Mirrored server-side in app-block-runtime.metrics. */
export const LAUNCH_PHASES = ['token_mint', 'frame_fetch', 'init_wait'] as const;
export type LaunchPhase = (typeof LAUNCH_PHASES)[number];

/**
 * Upper sanity bound on any single launch sample, in milliseconds.
 *
 * 30 s sits comfortably above `TOKEN_WAIT_TIMEOUT_MS` (15 s), the longest leg
 * that can legitimately complete — a `total` above 10 s is already structurally
 * impossible on the success path (`BLOCK_READY_TIMEOUT_MS` fires first and no
 * `ok` beacon is sent). Anything past 30 s is a suspended tab, a clock anomaly,
 * or a bug.
 *
 * 🔴 DROPPED, NEVER CLAMPED — mirrors `observeCustomComfyWallclockSeconds`. A
 * clamp folds junk onto the `+Inf` edge and poisons `_sum` and every tail
 * quantile with a value that was never real.
 */
export const MAX_LAUNCH_SAMPLE_MS = 30_000;

/**
 * The iframe-document fetch, as read from the PARENT's resource timeline.
 *
 * ✅ MEASURED (Chromium 151.0.7922.71, two-port loopback harness, 2026-08-03):
 * a cross-origin iframe document navigation DOES appear in the parent's
 * `performance.getEntriesByType('resource')` with `initiatorType: 'iframe'`, and
 * **without `Timing-Allow-Origin` the entry still carries real, non-zero
 * `startTime`, `responseEnd` and `duration`.** Only the DECOMPOSITION is zeroed
 * (`domainLookupStart/End`, `connectStart/End`, `requestStart`, `responseStart`,
 * `transferSize`, `encodedBodySize`, empty `nextHopProtocol`). Controls: a
 * cross-origin `<img>` shows the identical zeroing (so it is the standard
 * cross-origin TAO restriction, not iframe-specific), and a same-origin iframe
 * has every field in both runs (so it is genuinely cross-origin, not "iframes
 * never get timings").
 *
 * 🔴 CONSEQUENCE: `frame_fetch` is available at **100% coverage today**, on every
 * app, with no TAO header and no fleet rebuild. Earlier drafts of the design gated
 * this phase on `connectEnd > 0` and carried a `tao: present|absent` coverage
 * label; the measurement retired both. See the SUB-PHASE SEAM note at the bottom
 * of this file for what TAO would still buy and why it is deferred.
 */
export type LaunchFrameTiming = {
  /** `responseEnd - startTime` for the iframe document. */
  durationMs: number;
};

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
  frameFetchMs?: number;
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
 * A bounded, strictly-positive millisecond delta, or `undefined`.
 *
 * 🔴 THE `> 0` IS THE "NEVER EMIT A ZERO" RULE, and it is why this is one
 * function rather than three inline subtractions. A zero is indistinguishable
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

function normalizeUrl(raw: string): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    url.hash = '';
    return url.toString();
  } catch {
    return raw;
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Find the parent's `PerformanceResourceTiming` entry for the block iframe.
 *
 * Matched by URL only, deliberately: the parent document has no other reason to
 * fetch `https://<slug>.civit.ai/`, and `initiatorType` for a subframe document
 * is browser-dependent (measured as `iframe` in Chromium 151; Safari has
 * historically not surfaced subframe navigations in the parent timeline at all).
 * Filtering on it would turn a browser quirk into a silently missing phase.
 * Last match wins — a re-keyed iframe (the manual Retry path) adds a second
 * entry.
 *
 * Prefers the entry's own `duration`; falls back to `responseEnd - startTime`
 * (identical by spec) for an entry-like object that only carries the endpoints.
 *
 * Returns `null` when nothing matches — a fully supported state (e.g. the
 * ~250-entry resource buffer overflowed on a heavy page). The caller then emits
 * no `frame_fetch` sample; `token_mint` / `init_wait` / `total` are unaffected.
 */
export function matchIframeResourceEntry(
  src: string,
  entries: ReadonlyArray<{
    name?: unknown;
    duration?: unknown;
    startTime?: unknown;
    responseEnd?: unknown;
  }>
): LaunchFrameTiming | null {
  const target = normalizeUrl(src);
  if (!target) return null;
  let match: LaunchFrameTiming | null = null;
  for (const entry of entries) {
    if (typeof entry?.name !== 'string') continue;
    if (normalizeUrl(entry.name) !== target) continue;
    const duration =
      typeof entry.duration === 'number' && Number.isFinite(entry.duration) && entry.duration > 0
        ? entry.duration
        : numberOrZero(entry.responseEnd) - numberOrZero(entry.startTime);
    match = { durationMs: duration };
  }
  return match;
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

/** Browser-side wrapper. Never throws; returns `null` outside a DOM. */
export function readIframeResourceTiming(src: string): LaunchFrameTiming | null {
  try {
    if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function')
      return null;
    return matchIframeResourceEntry(src, performance.getEntriesByType('resource'));
  } catch {
    return null;
  }
}

/**
 * Turn the marks + the (optional) iframe resource entry into the beacon's
 * `timings` object, or `null` when this launch must not be observed at all.
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
export function computeLaunchTimings(
  marks: LaunchMarks,
  frame: LaunchFrameTiming | null
): LaunchTimingsPayload | null {
  if (marks.wasHidden) return null;

  const totalMs = boundedDeltaMs(marks.mountedAt, marks.readyAt);
  if (totalMs === undefined) return null;

  const tokenMintMs = boundedDeltaMs(marks.mountedAt, marks.tokenAt);
  const initWaitMs = boundedDeltaMs(marks.initSentAt, marks.readyAt);
  const frameFetchMs = frame ? boundedDurationMs(frame.durationMs) : undefined;

  return {
    totalMs,
    ...(tokenMintMs !== undefined ? { tokenMintMs } : {}),
    ...(frameFetchMs !== undefined ? { frameFetchMs } : {}),
    ...(initWaitMs !== undefined ? { initWaitMs } : {}),
  };
}

// ─── DEFERRED: the sub-phase (DNS / connect / TTFB) breakdown ─────────────────
//
// `frame_fetch` above is the TOTAL iframe-document fetch. Splitting it into
// DNS vs TCP+TLS vs TTFB needs `domainLookupStart/End`, `connectStart/End` and
// `responseStart`, which a cross-origin response only discloses when it sends
// `Timing-Allow-Origin` — and TAO is baked into each block's IMAGE at build
// time, so it would take a ~20-app rebuild (20 pushes + 20 moderator approvals;
// `blocks.retriggerBuild` refuses a `live` deploy state outright).
//
// 🔴 THAT REBUILD IS CANCELLED, deliberately. The decision TAO was meant to
// serve is "is `preconnect` worth shipping?", and that needs the TOTAL, not the
// split: ship preconnect and A/B this `frame_fetch` distribution. TAO is
// explanatory, not decisive.
//
// If the breakdown is ever wanted, the seam is small and lives entirely in this
// file plus the histogram's label set: read the extra fields in
// `matchIframeResourceEntry`, gate each sub-phase on `connectEnd > 0` (the
// direct observable for "this response carried TAO" — a zero there means "not
// disclosed", never "instant", so it must be DROPPED and never emitted as 0),
// and carry a `tao: present|absent` label so the coverage denominator is visible
// on the panel rather than a biased subset being quoted fleet-wide.
