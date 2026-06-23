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
 *  - PRIVACY: logs ONLY the procedure path (a fixed dotted name like
 *    `image.getInfinite`), the procedure type, the duration, success/error, and the
 *    numeric userId. It does NOT touch the procedure INPUT, so no prompt / PII is
 *    ever captured (the procedure NAME is the actionable signal here — unlike the
 *    audit case where the input shape WAS the bug).
 */

const DEFAULT_SLOW_MS = 3000;

// Read lazily per-call from process.env so the threshold is tunable without a
// rebuild (set TRPC_SLOW_LOG_MS on the deployment to retune).
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
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
    const slowMs = envNumber('TRPC_SLOW_LOG_MS', DEFAULT_SLOW_MS);
    // Below threshold: do nothing. No allocation, no log. (The common case.)
    if (input.durationMs < slowMs) return;
    emitSlowLog(input, slowMs);
  } catch {
    // Instrumentation must never throw into the request path.
  }
}

function emitSlowLog(input: TrpcSlowLogInput, slowMs: number): void {
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

      const { logToAxiom } = await import('~/server/logging/client');
      await logToAxiom(payload);
    } catch {
      // Logging failure must never surface.
    }
  })();
}
