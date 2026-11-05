/**
 * Every bound the runner enforces, in one place. The README's "Limits" table is written from
 * this file; change both together.
 */

/** QuickJS heap cap per call (`runtime.setMemoryLimit`). A 32 MiB allocation is refused. */
export const MEMORY_LIMIT_BYTES = 16 * 1024 * 1024;

/**
 * QuickJS stack cap per call (`runtime.setMaxStackSize`).
 *
 * Not 512 KiB: measured on Node 24.21 / quickjs-ng 0.32.0, a 512 KiB QuickJS stack lets the
 * interpreter recurse deeper than the HOST (V8) stack allows, so unbounded recursion surfaces as
 * a host `RangeError` thrown out of `evalCode` instead of a catchable in-VM one. At 64, 128, 256
 * and 384 KiB the in-VM limit fires first (recursion depths 368, 741, 1486 and 2230). 256 KiB
 * keeps a 2x margin under the host limit and still allows ~1,400 frames, far beyond what a
 * permission check needs. The sandbox also maps a host `RangeError` to `stack_overflow`, so a
 * smaller host stack degrades to a refusal, never to a crash.
 */
export const MAX_STACK_BYTES = 256 * 1024;

/** Per-call time budget. The manifest's `timeoutMs` is clamped to [MIN, MAX] whatever is sent. */
export const TIMEOUT_DEFAULT_MS = 50;
export const TIMEOUT_MIN_MS = 1;
export const TIMEOUT_MAX_MS = 500;

/**
 * The worker backstop. The interrupt handler only runs when QuickJS polls it, and a single
 * native operation does not poll: measured, an allocation loop that grows towards the memory cap
 * ran 1.3 s with ONE interrupt poll and a 50 ms deadline. A call still running at
 * `timeoutMs + BACKSTOP_MS` gets its worker terminated and answers `timeout`.
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
