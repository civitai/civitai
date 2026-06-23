/**
 * Slow-tRPC-procedure instrumentation.
 *
 * WHY THIS EXISTS: civitai-dp-prod api-primary (and SSR) periodically grow a
 * latency TAIL — a small fraction of requests park for 5-30s while P50/P95 stay
 * healthy. The requests complete (200), wait OFF-CPU (event loop, redis, CNPG all
 * measured fast during the tail), and are INVISIBLE to the existing telemetry:
 *  - spanmetrics only break out a handful of custom spans, not the ~870 tRPC
 *    procedures, so the slow one can't be named from Prometheus;
 *  - `trpcProcedureDuration` (the per-path histogram in trpc.ts) is OPT-IN
 *    (`TRPC_PROCEDURE_METRICS`) and OFF by default because it is high-cardinality;
 *  - Tempo can't resolve these requests (the timed-out/slow root span never
 *    flushes — the documented "root span not received" blind spot).
 *
 * This module closes that gap the same way `audit-slow-log.ts` cracked the 504
 * waves: an always-on, threshold-gated detector that names the offender on the
 * NEXT occurrence. The procedure-timing middleware records one `performance.now()`
 * delta per procedure and, ONLY when it exceeds `TRPC_SLOW_LOG_MS`, emits ONE
 * structured `logToAxiom` line naming the procedure path + type + duration + ok.
 * Query in Loki: `{namespace="civitai-dp-prod"} | json | name="trpc-procedure-slow"`.
 *
 * Design guarantees (mirrors audit-slow-log):
 *  - NEVER throws, NEVER delays the request path. All logging is best-effort and
 *    swallowed.
 *  - Below threshold (the overwhelming common case): just a numeric comparison —
 *    no allocation, no string work, no log. Zero cardinality cost (it's a log line,
 *    not a metric, and only emitted on the rare slow procedure).
 *  - SELF-AMPLIFICATION GUARD: during a real tail wave MANY procedures cross the
 *    threshold at once, and `logToAxiom` is a synchronous `console.error` per call
 *    (no built-in sampling). A per-pod token cap (`TRPC_SLOW_LOG_MAX_PER_SEC`,
 *    default 50/s) bounds the stderr burst so the instrument can't add load to a
 *    pod that's already sick. Suppressed lines are NOT silently dropped — the count
 *    since the last emitted line is attached as `droppedSinceLastLog` so the storm
 *    magnitude stays visible.
 *  - PRIVACY: logs ONLY the procedure path (a fixed dotted name like
 *    `image.getInfinite`), the procedure type, the duration, success/error, and the
 *    numeric userId. It does NOT touch the procedure INPUT, so no prompt / PII is
 *    ever captured (the procedure NAME is the actionable signal here — unlike the
 *    audit case where the input shape WAS the bug).
 *
 * Env knobs (read lazily per-call, tunable without a rebuild):
 *  - TRPC_SLOW_LOG_ENABLED (default true)  — instant kill-switch.
 *  - TRPC_SLOW_LOG_MS       (default 5000) — per-procedure slow threshold, ms.
 *  - TRPC_SLOW_LOG_MAX_PER_SEC (default 50) — per-pod emit cap (storm guard).
 */

const DEFAULT_SLOW_MS = 5000;
const DEFAULT_MAX_PER_SEC = 50;

// Read lazily per-call from process.env so values are tunable without a rebuild.
// `min` lets the threshold/cap reject 0 and negatives (which would mean "log
// everything" — a firehose footgun) and fall back to the default instead.
function envNumber(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return raw.toLowerCase() === 'true' || raw === '1';
}

// Per-pod (per-process) emit rate limiter. State is module-local — one window per
// pod. Synchronous + allocation-free; runs before the async emit tail.
let rlWindowStartMs = 0;
let rlCountThisWindow = 0;
let rlDroppedSinceEmit = 0;

/**
 * Token-bucket-ish per-second gate. Returns the number of lines suppressed since
 * the last EMITTED line (to attach to this one), or -1 if THIS call must itself be
 * dropped. Never throws.
 */
function rateGate(maxPerSec: number, now: number = Date.now()): number {
  if (now - rlWindowStartMs >= 1000) {
    rlWindowStartMs = now;
    rlCountThisWindow = 0;
  }
  if (rlCountThisWindow >= maxPerSec) {
    rlDroppedSinceEmit++;
    return -1;
  }
  rlCountThisWindow++;
  const carried = rlDroppedSinceEmit;
  rlDroppedSinceEmit = 0;
  return carried;
}

/** TEST-ONLY: reset the per-pod rate-limiter window so tests don't share state. Not called by runtime code. */
export function __resetTrpcSlowLogRateLimit(): void {
  rlWindowStartMs = 0;
  rlCountThisWindow = 0;
  rlDroppedSinceEmit = 0;
}

/** TEST-ONLY: drive `rateGate` with an explicit clock for deterministic assertions. */
export function __rateGateForTest(maxPerSec: number, now: number): number {
  return rateGate(maxPerSec, now);
}

export interface TrpcSlowLogInput {
  /** Fixed dotted procedure name, e.g. `image.getInfinite`. */
  path: string;
  /** tRPC procedure kind: 'query' | 'mutation' | 'subscription'. */
  type: string;
  /** Full chain + resolver wall-clock time in ms. */
  durationMs: number;
  /** Whether the procedure resolved successfully. */
  ok: boolean;
  /** TRPCError code when !ok (e.g. 'TIMEOUT', 'INTERNAL_SERVER_ERROR'). */
  errorCode?: string;
  /** Numeric user id (internal, not PII) when authenticated. */
  userId?: number;
}

/**
 * Threshold check + best-effort emit. Call on EVERY procedure completion (success
 * AND error). Any failure here is swallowed so instrumentation can never throw or
 * slow the request path.
 */
export function maybeLogTrpcSlow(input: TrpcSlowLogInput): void {
  try {
    if (!envBool('TRPC_SLOW_LOG_ENABLED', true)) return;
    const slowMs = envNumber('TRPC_SLOW_LOG_MS', DEFAULT_SLOW_MS, 1);
    // NaN-safe gate: only proceed when clearly AT/ABOVE threshold. Written as
    // `!(>=)` (not `< slowMs`) so a NaN duration — `NaN < x` is false — is rejected
    // rather than slipping through and emitting a `durationMs: null` line.
    if (!(input.durationMs >= slowMs)) return;
    // Per-pod storm guard: cap emitted lines/sec so a fleet-wide tail wave can't
    // turn into an unbounded stderr burst on already-stressed pods.
    const maxPerSec = envNumber('TRPC_SLOW_LOG_MAX_PER_SEC', DEFAULT_MAX_PER_SEC, 1);
    const droppedSinceLast = rateGate(maxPerSec);
    if (droppedSinceLast < 0) return; // suppressed; counted onto the next emitted line
    emitSlowLog(input, slowMs, droppedSinceLast);
  } catch {
    // Instrumentation must never throw into the request path.
  }
}

function emitSlowLog(input: TrpcSlowLogInput, slowMs: number, droppedSinceLast: number): void {
  // Defensive server-only guard (trpc.ts is server-only, but keep parity with
  // audit-slow-log so the node-only logging client is never reached client-side).
  if (typeof window !== 'undefined') return;

  const round = (n: number) => Math.round(n * 100) / 100;

  // Fire-and-forget async tail — fully swallowed. Kept off the synchronous return
  // so the request path never waits on the Axiom/Loki client.
  void (async () => {
    try {
      const payload: Record<string, unknown> = {
        name: 'trpc-procedure-slow',
        type: 'warning',
        path: input.path,
        procedureType: input.type,
        durationMs: round(input.durationMs),
        thresholdMs: slowMs,
        ok: input.ok,
      };
      if (input.errorCode) payload.errorCode = input.errorCode;
      if (input.userId != null) payload.userId = input.userId;
      // Surface suppressed-line count so a storm is visible, never silently capped.
      if (droppedSinceLast > 0) payload.droppedSinceLastLog = droppedSinceLast;

      const { logToAxiom } = await import('~/server/logging/client');
      await logToAxiom(payload);
    } catch {
      // Logging failure must never surface.
    }
  })();
}
