// Background dependency-health loop, for METRICS ONLY.
//
// The healthcheck metrics (healthcheck_attempts_total, healthcheck_duration_seconds, the per-check
// and overall counters) are incremented only when runHealthChecks() runs, and until now the only
// thing that ran it in steady state was the readiness probe calling /api/health. A readiness
// probe that stops doing dependency I/O therefore also stops every series those metrics feed, and
// any alert built on them reads 0 forever without ever looking broken. This loop keeps the same
// checks running on a fixed cadence inside the process, so the metrics keep flowing whatever the
// probe is pointed at.
//
// What it must never do, and how each is held:
//  - Affect readiness, liveness or request handling. Nothing reads its result: it calls
//    runHealthChecks() and discards the return value. It holds no lock or cache the probes use;
//    its overlap guard is its own, and the probe's clean-run reuse is untouched.
//  - Throw or reject into the process. Every run is wrapped; a failure is logged at debug, once
//    per failure streak, and the next tick runs as normal.
//  - Keep the process alive. Both timers are unref()'d.
//  - Pile up. A tick that finds the previous run still in flight is skipped. Each run is already
//    bounded by the per-check timeout and the overall deadline inside runHealthChecks().
//  - Add load while the probe still does the work. A tick is skipped when a probe started a full
//    run within the last interval, so with the probe still on /api/health the loop mostly idles
//    and, once the probe stops, it is the only source.
//
// Cadence is FIXED-RATE (setInterval), not "wait N ms after the last run finished": a slow or
// timing-out run must not stretch the period, because per-pod failure-rate alerts read the attempt
// rate, and a failing pod has to keep producing attempts at the configured rate to be seen.
// The start is offset by a random fraction of one interval so pods that boot together do not run
// their checks in lockstep against the same databases.
//
// Config: HEALTH_METRICS_INTERVAL_MS (default 15000). Zero or negative turns the loop off; a value
// that is not a number falls back to the default.

import { getLastProbeRunStartedAt, runHealthChecks } from '~/server/health/dependency-checks';

export const DEFAULT_HEALTH_METRICS_INTERVAL_MS = 15_000;
const LOG_PREFIX = '[health-metrics-loop]';

/** HEALTH_METRICS_INTERVAL_MS → interval in ms, or null when the loop is switched off. */
export function resolveHealthMetricsIntervalMs(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return DEFAULT_HEALTH_METRICS_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_HEALTH_METRICS_INTERVAL_MS;
  if (parsed <= 0) return null;
  return Math.floor(parsed);
}

export type HealthMetricsLoopOptions = {
  /** Defaults to HEALTH_METRICS_INTERVAL_MS. */
  intervalMs?: number | null;
  /** One run of the checks. Defaults to the shared runHealthChecks(). */
  run?: () => Promise<unknown>;
  /** When a probe last started a full run, on the `now` clock. */
  lastProbeRunStartedAt?: () => number;
  now?: () => number;
  random?: () => number;
};

type LoopHandle = {
  stop: () => void;
  /** The pending start timer, then the interval timer. Exposed for tests. */
  timers: () => NodeJS.Timeout[];
};

// One loop per PROCESS. register() runs once, but this module can be emitted into more than one
// runtime module by the bundler, and a module-scope flag would then let each copy start its own.
declare global {
  // eslint-disable-next-line no-var
  var __civitaiHealthMetricsLoop: LoopHandle | undefined;
}

const defaultRun = () => runHealthChecks(new AbortController().signal, { source: 'metrics-loop' });

/**
 * Start the loop. Idempotent per process; returns null when it is switched off (or during a
 * build). Never throws.
 */
export function startHealthMetricsLoop(options: HealthMetricsLoopOptions = {}): LoopHandle | null {
  try {
    if (globalThis.__civitaiHealthMetricsLoop) return globalThis.__civitaiHealthMetricsLoop;
    if (process.env.IS_BUILD === 'true') return null;

    const intervalMs =
      options.intervalMs !== undefined
        ? options.intervalMs
        : resolveHealthMetricsIntervalMs(process.env.HEALTH_METRICS_INTERVAL_MS);
    if (intervalMs === null || !(intervalMs > 0)) {
      console.log(`${LOG_PREFIX} off (HEALTH_METRICS_INTERVAL_MS <= 0)`);
      return null;
    }

    const run = options.run ?? defaultRun;
    const lastProbeRunStartedAt = options.lastProbeRunStartedAt ?? getLastProbeRunStartedAt;
    const now = options.now ?? (() => performance.now());
    const random = options.random ?? Math.random;

    let inFlight = false;
    let failing = false;
    const logFailure = (err: unknown) => {
      if (failing) return;
      failing = true;
      console.debug(`${LOG_PREFIX} run failed (metrics only; readiness unaffected):`, err);
    };

    const tick = () => {
      if (inFlight) return;
      // A probe already ran the full set within this interval: its run fed the same metrics.
      if (now() - lastProbeRunStartedAt() < intervalMs) return;
      inFlight = true;
      let pending: Promise<unknown>;
      try {
        pending = Promise.resolve(run());
      } catch (err) {
        pending = Promise.reject(err);
      }
      pending.then(
        () => {
          failing = false;
          inFlight = false;
        },
        (err) => {
          logFailure(err);
          inFlight = false;
        }
      );
    };

    let startTimer: NodeJS.Timeout | undefined;
    let intervalTimer: NodeJS.Timeout | undefined;
    const jitter = Math.floor(Math.min(Math.max(random(), 0), 0.999) * intervalMs);
    startTimer = setTimeout(() => {
      startTimer = undefined;
      intervalTimer = setInterval(tick, intervalMs);
      intervalTimer.unref();
      tick();
    }, jitter);
    startTimer.unref();

    const handle: LoopHandle = {
      stop: () => {
        if (startTimer) clearTimeout(startTimer);
        if (intervalTimer) clearInterval(intervalTimer);
        startTimer = intervalTimer = undefined;
        if (globalThis.__civitaiHealthMetricsLoop === handle) {
          globalThis.__civitaiHealthMetricsLoop = undefined;
        }
      },
      timers: () => [startTimer, intervalTimer].filter((t): t is NodeJS.Timeout => t !== undefined),
    };
    globalThis.__civitaiHealthMetricsLoop = handle;
    console.log(`${LOG_PREFIX} on: every ${intervalMs}ms, first run in ${jitter}ms`);
    return handle;
  } catch (err) {
    console.debug(`${LOG_PREFIX} failed to start (metrics only; readiness unaffected):`, err);
    return null;
  }
}
