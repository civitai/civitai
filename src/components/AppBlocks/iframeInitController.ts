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
// immediately and then RE-POST it on a short interval until the block
// acknowledges with BLOCK_READY (or the readiness timeout fires). This is
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

/** Re-post BLOCK_INIT this often until the block acks with BLOCK_READY. */
export const INIT_RETRY_INTERVAL_MS = 400;

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
  /** ms between BLOCK_INIT re-sends. Defaults to INIT_RETRY_INTERVAL_MS. */
  retryIntervalMs?: number;
}

/**
 * Drives the BLOCK_INIT handshake: posts init immediately on `start()`, arms
 * the readiness timeout, and re-posts init every `retryIntervalMs` until the
 * block acks (`notifyReady()`) or the timeout fires. Idempotent: a second
 * `start()` is a no-op, and `notifyReady()` / `dispose()` after stop do
 * nothing. Stateless wrt React — `IframeHost` owns one instance per mount.
 */
export class IframeInitController {
  private readonly opts: Required<IframeInitControllerOptions>;
  private started = false;
  private stopped = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor(options: IframeInitControllerOptions) {
    this.opts = {
      ...options,
      // Resolve the retry interval explicitly so an `undefined` passed in
      // `options` (e.g. `retryIntervalMs: undefined`) doesn't clobber the
      // default via spread — `setInterval(fn, undefined)` would fire as fast
      // as possible.
      retryIntervalMs: options.retryIntervalMs ?? INIT_RETRY_INTERVAL_MS,
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
    this.opts.sendInit();

    this.intervalId = setInterval(() => {
      // Defensive: if we've stopped between ticks, do nothing. (clearInterval
      // already prevents this; belt-and-suspenders for fake-timer edge cases.)
      if (this.stopped) return;
      this.opts.sendInit();
    }, this.opts.retryIntervalMs);

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
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }
}
