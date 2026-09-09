// Pure init-handshake controller for IframeHost. Extracted so the
// retry-until-ack + readiness-timeout orchestration is unit-testable in the
// node vitest env (civitai-web's vitest runs `environment: 'node'`, collects
// only `*.test.ts`, and has no RTL — so full Mantine/trpc component renders
// aren't available). Mirrors the existing W7/W8 pure-helper pattern
// (hostRenderDecision, resolveRequestSignIn, resolveBuzzPurchaseRequest,
// extractRequestId): the host effect stays thin and the tricky timing logic
// lives here behind a deterministic, injectable surface.
//
// WHY THIS EXISTS (the prod bug it fixes)
// --------------------------------------
// The host used to send BLOCK_INIT exactly once, gated on the iframe's React
// `onLoad` having fired (`iframeLoaded`). On prod the block bundle
// (`<slug>.civit.ai`) is cached, so the iframe `load` event can fire BEFORE
// React attaches the `onLoad` handler → the event is missed → `iframeLoaded`
// never flips → BLOCK_INIT is never posted → the block sits blank and its
// own transport rejects with "timed out waiting for BLOCK_INIT after 10000ms".
//
// THE FIX
// -------
// Stop depending on the `load` event. Once we're allowed to init (token
// present + effective-checkpoint query resolved) we POST BLOCK_INIT
// immediately and then RE-POST it on a short, front-loaded backoff schedule
// (`INIT_RETRY_BACKOFF_MS`, settling at `INIT_RETRY_INTERVAL_MS`) until the
// block acknowledges with BLOCK_READY (or the readiness timeout fires). This is
// robust to BOTH the missed-load race AND posting before the block's message
// listener is attached (an early post is simply dropped by the block and the
// next tick re-sends).
//
// WHY REPEATED SENDS ARE SAFE (verified against the SDK transport)
// ----------------------------------------------------------------
// The block's IframeTransport (civitai-blocks-react
// src/internal/iframeTransport.ts):
//   - origin-checks every inbound message: `if
//     (!this.allowedOrigins.has(event.origin)) return;`
//   - dedupes init: the BLOCK_INIT branch is guarded by `if
//     (!this.initResolved)` which it sets true on the first valid init;
//     subsequent BLOCK_INITs are ignored.
// So re-posting BLOCK_INIT is idempotent on the block side. A cross-origin
// `iframe.contentDocument.readyState` check is NOT an option (cross-origin
// access throws) — hence retry-until-ack rather than load-detection.
//
// READINESS TIMEOUT (the silent-blank guard)
// ------------------------------------------
// The readiness timeout is armed by `start()` — i.e. when we BEGIN trying to
// init — NOT gated on the iframe having loaded. Previously it was only armed
// inside the `iframeLoaded && token` effect, so if `iframeLoaded` never
// flipped (exactly this bug) NO timeout fired and the user saw an indefinite
// skeleton. Now a genuinely-broken block still surfaces a `timeout` fallback.

/**
 * STEADY-STATE re-post period, in ms. Used for every gap after the short
 * front-loaded backoff in `INIT_RETRY_BACKOFF_MS` is exhausted.
 *
 * 🔴 UNCHANGED AT 400 ON PURPOSE. The long tail of this loop is a
 * keep-trying-until-timeout safety net for a block that is genuinely slow or
 * broken; making it faster only multiplies wasted `postMessage`s into a frame
 * that is not listening. What changed is the FRONT of the schedule — see below.
 */
export const INIT_RETRY_INTERVAL_MS = 400;

/**
 * The FIRST re-post gaps, in ms, before the schedule settles at
 * `INIT_RETRY_INTERVAL_MS`. Gap `n` (0-indexed, counted from the immediate post
 * `start()` makes) is `INIT_RETRY_BACKOFF_MS[n] ?? INIT_RETRY_INTERVAL_MS`.
 *
 * With today's values the posts land at t = 0, 50, 150, 350, then every 400 ms.
 *
 * WHY (and what is hypothesis vs. measurement)
 * --------------------------------------------
 * MEASURED, production, 7 days to 2026-08-31, n=88 successful launches: the
 * `init_wait` phase (first BLOCK_INIT -> BLOCK_READY) dominates end-to-end
 * launch, and 30% of launches (26/87 with a phase sample) land in a single
 * 0.4-0.6 s band.
 *
 * 🔴 THAT BAND IS A FINGERPRINT, NOT A DIAGNOSIS. It is equally consistent with
 * (a) the flat 400 ms re-post quantization — a block whose listener attaches at
 * t=10 ms waits out the rest of the tick and acks just after 400 — and with
 * (b) blocks that simply take 400-600 ms to boot. Nothing shipped could tell
 * those apart, which is why this change also ships the discriminating
 * instrument: the number of BLOCK_INIT posts made before the ack, carried on
 * the launch beacon (`initPosts` in launchTimings.ts). Under (a) the 0.4-0.6 s
 * band is posts>=2; under (b) it is posts==1.
 *
 * A shorter FRONT is the only lever that helps every deployed app immediately.
 * The alternative — every block shipping the `BLOCK_HELLO` accelerator — is
 * real but is a rebuild-and-moderator-approve cycle per app, and as of the
 * 2026-08-31 fleet measurement only 4 of 23 deployed blocks carry it (see
 * `notifyHello` below and `blockInitFragmentGate.ts`).
 *
 * 🔴 WHY A SHORTER FRONT IS SAFE — the same property the header documents, and
 * it is a property of the GUEST, not a hope about timing. The block's
 * `IframeTransport` origin-checks every inbound message and latches
 * `initResolved` on the first valid BLOCK_INIT, ignoring every later one. So a
 * re-post is a proven no-op guest-side; the only cost of an early post is one
 * `postMessage` into a frame that may not be listening yet, which is dropped.
 * Three extra posts in the first 350 ms is the whole of the added cost.
 *
 * 🔴 WHAT THIS MUST NOT TOUCH, and does not: the readiness timeout
 * (`readyTimeoutMs`, wired to `BLOCK_READY_TIMEOUT_MS = 10_000`) is armed by
 * `start()` and is independent of the retry cadence; and `notifyHello()` still
 * posts immediately without consulting the schedule.
 */
export const INIT_RETRY_BACKOFF_MS: readonly number[] = [50, 100, 200];

/**
 * The gap before re-post number `n`, where `n = 0` is the first re-post AFTER
 * the immediate post `start()` makes.
 *
 * Exported so tests assert the real schedule rather than re-implementing the
 * `?? steady` fallback — a re-implementation is exactly how a test agrees with
 * a broken change.
 */
export function initRetryDelayMs(
  n: number,
  backoff: readonly number[] = INIT_RETRY_BACKOFF_MS,
  steady: number = INIT_RETRY_INTERVAL_MS
): number {
  return backoff[n] ?? steady;
}

/**
 * How many BLOCK_INIT posts one controller can make inside `windowMs` — the
 * immediate post plus every scheduled re-post that fires strictly before the
 * window closes.
 *
 * Exists so the `initPosts` sample bound is DERIVED from the schedule rather
 * than picked, mirroring `worstReachableLaunchMs()` / `MAX_LAUNCH_SAMPLE_MS`.
 * Widening the schedule then walks the bound and fails a test, instead of
 * silently making real samples fall off the top of the histogram.
 */
export function maxInitPostsWithin(
  windowMs: number,
  backoff: readonly number[] = INIT_RETRY_BACKOFF_MS,
  steady: number = INIT_RETRY_INTERVAL_MS
): number {
  if (!(windowMs > 0)) return 0;
  let posts = 1; // the immediate post at t = 0
  let t = 0;
  for (let n = 0; ; n += 1) {
    t += initRetryDelayMs(n, backoff, steady);
    // The readiness timeout at exactly `windowMs` runs before a re-post
    // scheduled for the same instant would matter, so this is a strict `<`.
    if (t >= windowMs) return posts;
    posts += 1;
  }
}

/**
 * Pure gate: are we ALLOWED to begin the BLOCK_INIT handshake?
 *
 * This is the predicate the host's init effect keys on. It deliberately does
 * NOT include any "iframe loaded" signal — that was the prod bug. The old
 * single-shot path required `iframeLoaded === true`, which never flipped when
 * the cached bundle's `load` event fired before React attached `onLoad`. The
 * correct gates are:
 *   - we're still in the loading state (haven't already initialized/failed),
 *   - the block token is present, and
 *   - the effective-checkpoint query has resolved (`!checkpointLoading`; the
 *     error path also resolves false and inits with checkpoint:null, as today).
 *
 * Extracted as a pure function so the load-independence is unit-testable in
 * the node vitest env (mirrors hostRenderDecision / resolveRequestSignIn).
 */
export function shouldStartInit(args: {
  // Accepts the model IframeHost statuses plus the W10 page host's `error`
  // terminal state. The gate only fires for `loading`, so any non-loading
  // status (terminal or otherwise) is a no-op — widening the union is
  // backward-compatible.
  status: 'loading' | 'ready' | 'timeout' | 'fatal' | 'no_token' | 'error';
  hasToken: boolean;
  checkpointLoading: boolean;
}): boolean {
  const { status, hasToken, checkpointLoading } = args;
  if (status !== 'loading') return false;
  if (!hasToken) return false;
  if (checkpointLoading) return false;
  return true;
}

export interface IframeInitControllerOptions {
  /** Post one BLOCK_INIT to the iframe (host's `send('BLOCK_INIT', payload)`). */
  sendInit: () => void;
  /** Fired once, when the readiness window elapses without a BLOCK_READY. */
  onReadyTimeout: () => void;
  /** ms to wait for BLOCK_READY before calling onReadyTimeout. */
  readyTimeoutMs: number;
  /**
   * STEADY-STATE ms between BLOCK_INIT re-sends, once `retryBackoffMs` is
   * exhausted. Defaults to INIT_RETRY_INTERVAL_MS.
   */
  retryIntervalMs?: number;
  /**
   * The leading re-post gaps before the steady interval takes over. Defaults to
   * INIT_RETRY_BACKOFF_MS. Pass `[]` for a flat schedule.
   */
  retryBackoffMs?: readonly number[];
}

/**
 * Drives the BLOCK_INIT handshake: posts init immediately on `start()`, arms
 * the readiness timeout, and re-posts init on the `INIT_RETRY_BACKOFF_MS`
 * schedule (settling at `retryIntervalMs`) until the block acks
 * (`notifyReady()`) or the timeout fires. Idempotent: a second
 * `start()` is a no-op, and `notifyReady()` / `dispose()` after stop do
 * nothing. Stateless wrt React — `IframeHost` owns one instance per mount.
 */
export class IframeInitController {
  private readonly opts: Required<IframeInitControllerOptions>;
  private started = false;
  private stopped = false;
  /** One-shot latch for `notifyHello()` — see its doc comment. */
  private helloHandled = false;
  /**
   * The re-post timer. A CHAINED `setTimeout`, not a `setInterval`, because the
   * gap is no longer constant — see `INIT_RETRY_BACKOFF_MS`.
   */
  private retryId: ReturnType<typeof setTimeout> | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  /** Which gap comes next: index into `retryBackoffMs`, then the steady value. */
  private retryIndex = 0;
  /** BLOCK_INIT posts made so far, including the immediate one from `start()`. */
  private posts = 0;

  constructor(options: IframeInitControllerOptions) {
    this.opts = {
      ...options,
      // Resolve the retry interval explicitly so an `undefined` passed in
      // `options` (e.g. `retryIntervalMs: undefined`) doesn't clobber the
      // default via spread — `setTimeout(fn, undefined)` would fire as fast
      // as possible.
      retryIntervalMs: options.retryIntervalMs ?? INIT_RETRY_INTERVAL_MS,
      retryBackoffMs: options.retryBackoffMs ?? INIT_RETRY_BACKOFF_MS,
    };
  }

  /**
   * Begin the handshake. Posts BLOCK_INIT once synchronously, arms the
   * readiness timeout, and schedules periodic re-sends. No-op if already
   * started or already stopped.
   */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;

    // Immediate first send — covers the common case where the block's
    // listener is already attached. Subsequent ticks cover the races
    // (missed load event, listener-not-yet-attached).
    this.post();
    this.scheduleNextRetry();

    // Arm the readiness timeout HERE — on init-start — not gated on the
    // iframe load event. This is the silent-blank guard.
    this.timeoutId = setTimeout(() => {
      if (this.stopped) return;
      this.stop();
      this.opts.onReadyTimeout();
    }, this.opts.readyTimeoutMs);
  }

  /** Whether start() has run (i.e. at least one BLOCK_INIT was posted). */
  hasStarted(): boolean {
    return this.started;
  }

  /**
   * BLOCK_INIT posts made by THIS controller so far — the immediate one plus
   * every re-post and every `notifyHello()` push.
   *
   * 🔴 NOT the host's launch counter. The host counts inside its own `sendInit`
   * callback so the number spans a whole launch (the auto-retry path builds a
   * FRESH controller per attempt, which would reset this one). This accessor
   * exists so the schedule is directly assertable in a unit test; it is not the
   * source of the beacon field.
   */
  postCount(): number {
    return this.posts;
  }

  private post(): void {
    this.posts += 1;
    this.opts.sendInit();
  }

  /**
   * Arm the timer for the next re-post. Re-arms itself, so the gap can grow
   * from `retryBackoffMs` into the steady `retryIntervalMs`.
   */
  private scheduleNextRetry(): void {
    const delay = initRetryDelayMs(
      this.retryIndex,
      this.opts.retryBackoffMs,
      this.opts.retryIntervalMs
    );
    this.retryIndex += 1;
    this.retryId = setTimeout(() => {
      // Defensive: if we've stopped between ticks, do nothing. (`stop()` clears
      // this timer already; belt-and-suspenders for fake-timer edge cases where
      // the readiness timeout and a re-post come due at the same instant.)
      if (this.stopped) return;
      this.post();
      this.scheduleNextRetry();
    }, delay);
  }

  /**
   * The block announced it is listening (`BLOCK_HELLO` — the inverted
   * handshake). Push BLOCK_INIT NOW rather than waiting out the remainder of
   * the current retry tick.
   *
   * 🔴 THIS IS AN ACCELERATOR, NOT A GATE. The retry interval and the readiness
   * timeout armed by `start()` are untouched, so:
   *   - a block on an OLDER SDK, which never sends `BLOCK_HELLO`, is served by
   *     the unchanged retry loop exactly as it is today;
   *   - a block that never announces AND never acks still hits `onReadyTimeout`
   *     at `readyTimeoutMs` — it cannot hang the host.
   * Nothing here may ever become a precondition for sending init.
   *
   * Honored AT MOST ONCE per controller: an announce is a one-shot signal from
   * the block's transport, so a repeat is either a duplicate or noise, and
   * answering every one would let a chatty frame amplify host work. An announce
   * that lands BEFORE `start()` is recorded and costs nothing — `start()` posts
   * init immediately on its own.
   */
  notifyHello(): void {
    if (this.helloHandled) return;
    this.helloHandled = true;
    if (!this.started || this.stopped) return;
    // Deliberately does NOT reschedule or reset the retry chain — an announce
    // is additive. The next re-post still lands on the schedule it was already
    // on, which is what keeps this an accelerator rather than a gate.
    this.post();
  }

  /**
   * The block acknowledged (BLOCK_READY). Stop re-sending and cancel the
   * readiness timeout. One extra in-flight tick before this lands is
   * acceptable — the block dedupes init — but no more after.
   */
  notifyReady(): void {
    this.stop();
  }

  /** Tear down all timers (unmount, or terminal status from another path). */
  dispose(): void {
    this.stop();
  }

  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.retryId !== null) {
      clearTimeout(this.retryId);
      this.retryId = null;
    }
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }
}
