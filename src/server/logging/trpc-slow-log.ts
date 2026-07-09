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
 *  - TRPC_SLOW_LOG_ENABLED (default true)  — kill-switch; disabled ONLY by an
 *    explicit falsy token (false/0/no/off), so it can't be accidentally turned off
 *    by setting it to yes/on/etc.
 *  - TRPC_SLOW_LOG_MS       (default 5000) — per-procedure slow threshold, ms.
 *    NOTE: catches the 5-30s tail; set it to 3000 on a pool to also see the 3-5s
 *    band during an active hunt.
 *  - TRPC_SLOW_LOG_MAX_PER_SEC (default 50) — per-pod ceiling backstop. The cap is
 *    PATH-DIVERSE (each distinct procedure named once/window), not a raw count, so
 *    a diverse storm still names which procedures are slow.
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

// Default-ON kill-switch: only an EXPLICIT falsy token disables. This avoids the
// footgun where an operator sets `=yes`/`=on`/`=enabled` to "turn it on" and a
// strict `==='true'` check silently turns it OFF instead. Anything that isn't a
// recognized off-token (or unset) keeps the instrument enabled.
function envDisabled(name: string): boolean {
  const raw = process.env[name];
  if (raw == null || raw === '') return false; // unset → enabled
  const v = raw.trim().toLowerCase();
  return v === 'false' || v === '0' || v === 'no' || v === 'off';
}

// Per-pod (per-process) emit rate limiter. State is module-local — one window per
// pod. Synchronous + allocation-light; runs before the async emit tail.
//
// PATH-DIVERSITY over raw count: a naive "max N lines/sec" cap, under a diverse
// tail wave where MANY distinct procedures are slow at once, would name only the
// first N arbitrary ones and collapse the rest into a counter — blinding the
// instrument to WHICH procedures are slow at the exact moment it exists to answer
// that. Instead we emit each distinct `path` AT MOST ONCE per 1s window (a repeat
// of an already-named path carries no new "which" signal and is suppressed), and
// keep a hard ceiling (`maxPerSec`) only as a backstop against a pathologically
// large distinct-path set. Net: every distinct slow procedure gets named each
// window, and the stderr burst stays bounded. (Per-path FREQUENCY is intentionally
// not logged here — recover it from Traefik/`TRPC_PROCEDURE_METRICS` rate; this
// instrument answers "which", not "how many".)
//
// NOTE: the window is a fixed TUMBLING 1s reset, not sliding — a burst spanning a
// boundary can emit up to ~2× the ceiling in a ~1ms span. At these absolute counts
// (≤2×50 tiny lines) that's intentionally accepted, not a hard guarantee.
let rlWindowStartMs = 0;
let rlCountThisWindow = 0;
let rlDroppedSinceEmit = 0;
let rlSeenPaths = new Set<string>();

/**
 * Per-window, path-aware gate. Returns the number of lines suppressed-by-ceiling
 * since the last EMITTED line (to attach to this one as `droppedSinceLastLog`), or
 * -1 if THIS call must be suppressed (a same-path repeat this window, OR the hard
 * ceiling is hit). Never throws.
 */
function rateGate(path: string, maxPerSec: number, now: number = Date.now()): number {
  if (now - rlWindowStartMs >= 1000) {
    rlWindowStartMs = now;
    rlCountThisWindow = 0;
    rlSeenPaths.clear();
  }
  // Already named this path this window → redundant, suppress (not a "dropped"
  // storm line; it carries no new which-procedure signal).
  if (rlSeenPaths.has(path)) return -1;
  // Hard ceiling backstop (bounds absolute volume under a huge distinct-path set).
  if (rlCountThisWindow >= maxPerSec) {
    rlDroppedSinceEmit++;
    return -1;
  }
  rlSeenPaths.add(path);
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
  rlSeenPaths.clear();
}

/** TEST-ONLY: drive `rateGate` with an explicit clock for deterministic assertions. */
export function __rateGateForTest(path: string, maxPerSec: number, now: number): number {
  return rateGate(path, maxPerSec, now);
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
    if (envDisabled('TRPC_SLOW_LOG_ENABLED')) return;
    const slowMs = envNumber('TRPC_SLOW_LOG_MS', DEFAULT_SLOW_MS, 1);
    // NaN-safe gate: only proceed when clearly AT/ABOVE threshold. Written as
    // `!(>=)` (not `< slowMs`) so a NaN duration — `NaN < x` is false — is rejected
    // rather than slipping through and emitting a `durationMs: null` line.
    if (!(input.durationMs >= slowMs)) return;
    // Per-pod storm guard: path-diverse cap so a tail wave names each distinct slow
    // procedure once/window while the absolute stderr burst stays bounded.
    const maxPerSec = envNumber('TRPC_SLOW_LOG_MAX_PER_SEC', DEFAULT_MAX_PER_SEC, 1);
    const droppedSinceLast = rateGate(input.path, maxPerSec);
    if (droppedSinceLast < 0) return; // suppressed (dup-this-window or ceiling)
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
  const tail = (async () => {
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
  // Track the in-flight tail so tests can deterministically await the emit
  // instead of racing a fixed wall-clock timeout (which fails on a loaded CI
  // box where the dynamic import() resolves slower). Removed on settle, so this
  // never retains memory in production.
  pendingEmits.add(tail);
  void tail.finally(() => pendingEmits.delete(tail));
}

const pendingEmits = new Set<Promise<void>>();

/** Test-only: resolve once every in-flight fire-and-forget emit tail has settled. */
export function __flushPendingEmitsForTest(): Promise<void> {
  return Promise.allSettled([...pendingEmits]).then(() => undefined);
}
