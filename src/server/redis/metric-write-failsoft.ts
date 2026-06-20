import { env } from '~/env/server';

/**
 * Fail-fast + fail-soft guard for NON-CRITICAL metric WRITE/LOCK cluster commands
 * (FIX #3 for the inflight-leak wedge).
 *
 * WHY: the metric write/lock commands — `metrics:lock:Image:<id>` setNX/expire
 * (entity-metric-populate.ts), the increment hIncrBy (entity-metric.redis.ts) — are pure
 * analytics/engagement counters. They are NOT money or entitlement: the values are
 * reaction/comment/collection/buzz-tip ROLLUP counts repopulated from ClickHouse on a cache
 * miss, and the locks are thundering-herd guards (a failed lock just means another process
 * may also populate, or the populate is skipped this call — the read path already fail-opens
 * to {} and the increment caller already swallows). EVIDENCE: imageMetricsCache.fetch's only
 * caller (image.service.ts getImageMetrics) catches and returns {}; the increment path
 * (metric-helpers.ts updateEntityMetric) catches and logs. So skipping any of these can
 * never move money or grant/deny entitlement — at worst a counter is momentarily stale.
 *
 * Under the 15s default cluster command deadline (REDIS_CLUSTER_COMMAND_TIMEOUT_MS), a
 * WEDGED cluster client makes each of these PARK up to 15s and then throw — which can 500 a
 * user mutation (or, where caught, add 15s of latency before the catch). This guard:
 *   1. FAIL-FAST: bounds the command at REDIS_METRIC_WRITE_TIMEOUT_MS (default 1.5s) instead
 *      of inheriting the 15s deadline, so a wedge is surfaced in ~1.5s not ~15s.
 *   2. FAIL-SOFT: on timeout OR any redis error, returns the caller-supplied `fallback`
 *      (e.g. `false` for a lock that "wasn't acquired", a benign number for an increment) and
 *      fires the onFail hook (log + Prometheus counter) — the user action proceeds.
 *
 * The happy path is UNCHANGED: a command that settles before the timeout returns its real
 * value with no fallback and no onFail.
 *
 * Cluster-scoped: only wrap cluster (cache) metric commands. The sysRedis client has its own
 * bounding (withSysReadDeadline) and is never wrapped here.
 */
export interface MetricWriteFailSoftOptions {
  /** Wall-clock timeout (ms). Defaults to REDIS_METRIC_WRITE_TIMEOUT_MS; <=0 falls back to
   *  REDIS_CLUSTER_COMMAND_TIMEOUT_MS (the existing 15s deadline) so disabling is explicit. */
  timeoutMs?: number;
  /** Short label for logs/metrics (e.g. 'populate-lock:setNX', 'increment:hIncrBy'). */
  op: string;
  /** Fire-and-forget hook on the fail-soft path: (op, error) => log + count. Never throws. */
  onFail?: (op: string, err: unknown) => void;
}

/**
 * Run a non-critical metric write/lock redis command with a short fail-fast timeout and a
 * fail-soft fallback. Resolves to the command's value on success, or `fallback` on
 * timeout/error (after invoking onFail). Never rejects.
 */
export async function withMetricWriteFailSoft<T>(
  run: () => Promise<T>,
  fallback: T,
  options: MetricWriteFailSoftOptions
): Promise<T> {
  const configured = options.timeoutMs ?? env.REDIS_METRIC_WRITE_TIMEOUT_MS;
  // <=0 means "no dedicated metric-write bound" → fall back to the global cluster deadline
  // (which still applies via instrumentCommands), preserving prior behavior.
  const ms = configured > 0 ? configured : env.REDIS_CLUSTER_COMMAND_TIMEOUT_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (ms && ms > 0) {
      // Start the command ONCE and hold the reference so we can reap its LATE rejection on
      // the timeout path (FIX #4). run() is the cluster command, itself wrapped by the 15s
      // withCommandDeadline — so when our 1.5s `deadline` wins the race, run() is still in
      // flight and rejects ~13.5s later. Without an attached handler that surfaces as an
      // `unhandledRejection`. Reap it explicitly (mirrors command-deadline.ts /
      // sys-read-deadline.ts, which assert no unhandledRejection in their tests).
      const running = run();
      running.catch(() => {
        /* reaped: the fail-soft fallback was already returned on the deadline path */
      });
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`metric write '${options.op}' timed out after ${ms}ms`)),
          ms
        );
      });
      return await Promise.race([running, deadline]);
    }
    return await run();
  } catch (err) {
    options.onFail?.(options.op, err);
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
