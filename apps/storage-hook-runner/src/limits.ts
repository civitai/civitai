/**
 * Every bound the runner enforces, in one place. The README's "Limits" table is written from
 * this file; change both together.
 */

/** QuickJS heap cap per call (`runtime.setMemoryLimit`). */
export const MEMORY_LIMIT_BYTES = 16 * 1024 * 1024;

/**
 * QuickJS stack cap per call (`runtime.setMaxStackSize`).
 *
 * Not 512 KiB: that lets the interpreter recurse deeper than the HOST (V8) stack allows, so
 * unbounded recursion surfaces as a host `RangeError` thrown out of `evalCode` instead of a
 * catchable in-VM one. 256 KiB keeps the in-VM limit firing first with a 2x margin, and still
 * allows far deeper recursion than a permission check needs. The sandbox also maps a host
 * `RangeError` to `stack_overflow`, so a smaller host stack degrades to a refusal, never to a
 * crash.
 */
export const MAX_STACK_BYTES = 256 * 1024;

/** Per-call time budget. The manifest's `timeoutMs` is clamped to [MIN, MAX] whatever is sent. */
export const TIMEOUT_DEFAULT_MS = 50;
export const TIMEOUT_MIN_MS = 1;
export const TIMEOUT_MAX_MS = 500;

/**
 * Allowance for the SECOND compile inside the armed evaluation (see `arm` in sandbox.ts): the
 * deadline is `timeoutMs` plus `COMPILE_ALLOWANCE_FACTOR` times the measured compile-only pass
 * plus `COMPILE_ALLOWANCE_FLOOR_MS`. The factor absorbs a second compile that runs slower than
 * the first in proportion to the source (a GC pause over a larger heap, a smaller CPU share); the
 * floor absorbs fixed-size jitter that does not scale with the source. Kept small because the
 * pool's backstop (`timeoutMs` + BACKSTOP_MS, from dispatch) does not include it: a looping hook
 * is interrupted about (1 + factor) x compile + floor + `timeoutMs` after dispatch.
 */
export const COMPILE_ALLOWANCE_FACTOR = 1.5;
export const COMPILE_ALLOWANCE_FLOOR_MS = 5;

/**
 * The worker backstop. The interrupt handler only runs when QuickJS polls it, and a single
 * native operation does not poll, so an allocation loop that grows towards the memory cap can run
 * far past its deadline between two polls. A call still running at
 * `timeoutMs + BACKSTOP_MS` gets its worker terminated and answers 500 (a runner fault, not the
 * author's `timeout`: see BackstopError in pool.ts).
 */
export const BACKSTOP_MS = 100;

/** Hook source size cap (UTF-8 bytes), matching the manifest-side cap. */
export const MAX_SOURCE_BYTES = 64 * 1024;

/**
 * Request body cap: 64 KiB of source plus two 64 KiB documents (before/after) plus envelope.
 */
export const MAX_BODY_BYTES = 256 * 1024;

/** The author's refusal reason is shown to users: at most this many characters (code points). */
export const REASON_MAX_CHARS = 200;

/** `detail` on an author-fault result is for the author's logs; capped the same way. */
export const DETAIL_MAX_CHARS = 200;

/** Allowed clock skew between signer and verifier, both directions, in seconds. */
export const SIG_SKEW_SECONDS = 60;

/** Header carrying `hex(HMAC-SHA256(secret, rawBody))`, on requests and on responses. */
export const SIG_HEADER = 'x-storage-hook-sig';

/** Bounded queue per pool; past it the runner answers 503 rather than queue without limit. */
export const DEFAULT_MAX_QUEUE = 64;

/** Default per-app cap (queued plus in flight): a quarter of the queue, rounded up, at least 1. */
export function defaultMaxPerApp(maxQueue: number): number {
  return Math.max(1, Math.ceil(maxQueue / 4));
}

/** Replacement-worker start retries: first delay, doubling up to the max. */
export const RESPAWN_BASE_MS = 100;
export const RESPAWN_MAX_MS = 30_000;

/** /healthz fails once the pool has had no ready worker for this long. */
export const DEAD_AFTER_MS = 30_000;
