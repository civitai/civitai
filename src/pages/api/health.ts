import type { NextApiRequest, NextApiResponse } from 'next';
import type client from 'prom-client';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { pgDbRead, pgDbWrite } from '~/server/db/pgDb';
import { logToAxiom } from '~/server/logging/client';
import {
  MeiliCallTimeoutError,
  metricsSearchClient,
  withMeiliHealthProbe,
} from '~/server/meilisearch/client';
import {
  registerCounter,
  registerCounterWithLabels,
  registerHistogram,
} from '~/server/prom/client';
import { redis, REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getRandomInt } from '~/utils/number-helpers';

function logError({ error, name, details }: { error: Error; name: string; details: unknown }) {
  if (isProd) {
    logToAxiom({
      name: `health-check:${name}`,
      type: 'error',
      details,
      message: error.message,
      stack: error.stack,
      cause: error.cause,
    }).catch();
  } else {
    console.log(`Failed to get a connection to ${name}`);
    console.error(error);
  }
}

// Type for cancellable check functions
type CancellableCheckFn = (signal: AbortSignal) => Promise<boolean>;

const checkFns: Record<string, CancellableCheckFn> = {
  // Prisma checks (Prisma doesn't support AbortSignal). `statement_timeout`
  // only bounds the query's *server-side duration once it RUNS* — it does NOT
  // bound the wait to acquire a pool connection (the slow path during a deploy
  // rollout, when PG connection churn can stall acquisition). The check is
  // still hard-bounded, but by the per-check wall-clock `runCheckWithTimeout`
  // race against setTimeout(HEALTHCHECK_TIMEOUT), NOT by statement_timeout: a
  // connection-acquisition hang resolves as a `timeout` at HEALTHCHECK_TIMEOUT.
  async write(signal: AbortSignal) {
    if (signal.aborted) return false;
    return !!(await dbWrite
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${env.HEALTHCHECK_TIMEOUT}`);
        return tx.$queryRawUnsafe(`SELECT 1`);
      })
      .catch((e) => {
        logError({ error: e, name: 'dbWrite', details: null });
        return false;
      }));
  },

  async read(signal: AbortSignal) {
    if (signal.aborted) return false;
    return !!(await dbRead
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${env.HEALTHCHECK_TIMEOUT}`);
        return tx.$queryRawUnsafe(`SELECT 1`);
      })
      .catch((e) => {
        logError({ error: e, name: 'dbRead', details: null });
        return false;
      }));
  },

  // pg checks - simple query with statement_timeout.
  // Note: cancellableQuery adds overhead (extra connection for pg_cancel_backend)
  // which isn't worth it for a simple SELECT 1. As with the Prisma checks above,
  // statement_timeout only limits query *duration* server-side once it runs — it
  // does NOT bound connection-acquisition wait. The hard ceiling on a hung
  // acquisition is the wall-clock `runCheckWithTimeout` race (HEALTHCHECK_TIMEOUT),
  // not statement_timeout.
  async pgWrite(signal: AbortSignal) {
    if (signal.aborted) return false;
    try {
      // Multi-statement queries through PgBouncer return rowCount: undefined,
      // so we just check that the query resolves without throwing
      await pgDbWrite.query(`SET LOCAL statement_timeout = ${env.HEALTHCHECK_TIMEOUT}; SELECT 1`);
      return true;
    } catch (e) {
      logError({ error: e as Error, name: 'pgWrite', details: null });
      return false;
    }
  },

  async pgRead(signal: AbortSignal) {
    if (signal.aborted) return false;
    try {
      await pgDbRead.query(`SET LOCAL statement_timeout = ${env.HEALTHCHECK_TIMEOUT}; SELECT 1`);
      return true;
    } catch (e) {
      logError({ error: e as Error, name: 'pgRead', details: null });
      return false;
    }
  },

  async searchMetrics(signal: AbortSignal) {
    if (signal.aborted) return false;
    const client = metricsSearchClient;
    if (client === null) return true;
    // Wrap under withMeiliHealthProbe() — a dedicated tiny limiter that's
    // ISOLATED from the user-traffic 'metricsSearch' limiter. Without this
    // isolation, a backend brownout starves the probe first (because user
    // calls fill the main limiter), kubelet trips at 10s, pods SIGKILL —
    // exactly the 2026-05-29 cascade. The probe also inherits
    // MEILI_CALL_TIMEOUT_MS so it can't hang.
    // A MeiliCallTimeoutError here means "Meili is sick" → probe failure.
    return await withMeiliHealthProbe(() => client.isHealthy()).catch((e) => {
      if (e instanceof MeiliCallTimeoutError) return false;
      logError({ error: e, name: 'metricsSearch', details: null });
      return false;
    });
  },

  // Redis cluster client: skip explicit PING because redis@5 cluster client
  // throws `Cannot read properties of undefined (reading 'connectPromise')`
  // when a master is transiently re-establishing. isReady is the canonical
  // signal — but be lenient: treat only explicit `false` as failure, since
  // it can briefly read undefined during topology refresh / cold start.
  async redis(signal: AbortSignal) {
    if (signal.aborted) return false;
    return (redis as any)?.isReady !== false;
  },

  async sysRedis(signal: AbortSignal) {
    if (signal.aborted) return false;
    try {
      const baseClient = sysRedis as any;
      if (baseClient.isReady === false) {
        return false;
      }
      const res = await (sysRedis as any).ping();
      return res === 'PONG';
    } catch (e) {
      if (signal.aborted || (e as Error).name === 'AbortError') return false;
      logError({ error: e as Error, name: 'sysRedis', details: null });
      return false;
    }
  },

  // ClickHouse - ping doesn't support abort_signal, cancellation handled at caller level
  async clickhouse(signal: AbortSignal) {
    if (signal.aborted) return false;
    if (!clickhouse) return true;
    try {
      const { success } = await clickhouse.ping();
      return success;
    } catch (e) {
      if (signal.aborted || (e as Error).name === 'AbortError') return false;
      logError({ error: e as Error, name: 'clickhouse', details: null });
      return false;
    }
  },
};
// Exported because it appears in the public signature of `runHealthChecks`
// below (its `results` return type), which /api/ready imports. A module-private
// name in an exported signature compiles under `next build` but errors under
// `--declaration` and is fragile.
export type CheckKey =
  | 'write'
  | 'read'
  | 'pgWrite'
  | 'pgRead'
  | 'searchMetrics'
  | 'redis'
  | 'sysRedis'
  | 'clickhouse';
// Static disable list from env (HEALTHCHECK_DISABLED="searchMetrics,clickhouse").
// Filtered to real check names so a typo can't silently swallow nothing-or-everything.
// Applies in all environments; the sysRedis DISABLED_HEALTHCHECKS list (prod-only)
// is layered on top at request time.
const envDisabledChecks: CheckKey[] = (env.HEALTHCHECK_DISABLED ?? []).filter(
  (name): name is CheckKey => name in checkFns
);

// Checks that ALWAYS run and record/emit their result (prom metric + response
// body), but must NEVER flip the overall `healthy` boolean that pod READINESS
// gates on. sysRedis is a SOFT dependency: a transient sysRedis stall (Sentinel
// cutover, node reschedule, AOF reload) must not fail /api/health across all
// pods and shed the whole fleet from the LB — that is the 2026-06-26 499/504
// outage wave. We still want to SEE sysRedis health, we just won't shed
// readiness on it.
//
// This is HARDCODED, deliberately NOT driven by the runtime
// NON_CRITICAL_HEALTHCHECKS sysRedis config: that list is itself read FROM
// sysRedis, and on a failed read runHealthChecks degrades to "run ALL checks,
// suppress NOTHING" (see the config-fetch leg below). So during an ACTUAL
// sysRedis outage — precisely when we need sysRedis treated as non-critical —
// the runtime lever evaporates and re-arms the fleet-shed. A static set is the
// only self-consistent way to make sysRedis non-critical. Disabling it via
// HEALTHCHECK_DISABLED would instead stop the check running and lose the metric.
// Scoped to sysRedis ONLY — every other check (DB, pg, cluster redis, meili,
// clickhouse) stays critical and still flips `healthy` on failure.
const STATIC_NON_CRITICAL_CHECKS: readonly CheckKey[] = ['sysRedis'];

const counters = (() =>
  [...Object.keys(checkFns), 'overall'].reduce((agg, name) => {
    agg[name as CheckKey] = registerCounter({
      name: `healthcheck_${name.toLowerCase()}`,
      help: `Healthcheck for ${name}`,
    });
    return agg;
  }, {} as Record<CheckKey | 'overall', client.Counter>))();

// New per-attempt outcome counter (success | failure | timeout) and per-check
// duration histogram. Added alongside the legacy per-check counters so existing
// Grafana dashboards keep working — these metrics ADD signal, they do not
// replace anything. See PR description for diagnostic context.
const healthcheckAttemptsCounter = registerCounterWithLabels({
  name: 'healthcheck_attempts_total',
  help: 'Healthcheck attempts by check name and outcome (success|failure|timeout)',
  labelNames: ['name', 'result'] as const,
});

const healthcheckDurationHistogram = registerHistogram({
  name: 'healthcheck_duration_seconds',
  help: 'Healthcheck wall-clock duration in seconds by check name',
  labelNames: ['name'] as const,
  // Buckets span 1ms..30s. Denser between 1-3.5s because that's where the
  // HEALTHCHECK_TIMEOUT brownout zone lives — coarse buckets there make
  // P95/P99 estimates useless for diagnosing the failure mode this exists for.
  buckets: [
    0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 1.5, 2, 2.5, 3.5, 5, 7.5, 10, 15, 20, 30,
  ],
});

type CheckOutcome = 'success' | 'failure' | 'timeout';

// Overall handler deadline. Every individual check is already bounded by
// runCheckWithTimeout(HEALTHCHECK_TIMEOUT), but the handler also does two
// sysRedis config reads (disabled + non-critical checks) before the checks.
// Each leg is separately raced at HEALTHCHECK_TIMEOUT, so if the deadline only
// bounded the check phase a slow sysRedis config read could consume up to
// HEALTHCHECK_TIMEOUT *before* the check deadline even started — summing to
// ~3× HEALTHCHECK_TIMEOUT and blowing past the kubelet probe's 10s
// timeoutSeconds, pulling the whole fleet from the LB (504/499) and tripping
// liveness SIGKILL (Error/137).
//
// To close that, the deadline is started at the very top of the handler and
// bounds the ENTIRE handler — both the config-fetch leg and the check leg race
// against the same timer. This guarantees the HTTP response always flushes
// well under the probe budget, regardless of whether any single dependency
// client honors its AbortSignal during e.g. a TCP connect hang.
//
// Sized as 2× HEALTHCHECK_TIMEOUT as the TOTAL budget for config fetch + checks
// combined, hard-capped at 8s so it stays comfortably under the 10s probe even
// when HEALTHCHECK_TIMEOUT is raised in prod.
function getOverallDeadlineMs() {
  return Math.min(env.HEALTHCHECK_TIMEOUT * 2, 8000);
}

/**
 * Run the full dependency-health check set and compute overall health.
 *
 * Extracted from the /api/health handler so /api/ready can reuse the EXACT
 * same checks, env/sysRedis disable lists, per-check timeouts, overall
 * deadline, and prom metrics — there is one source of truth for "are this
 * pod's dependencies healthy". The only thing that stays in the handler is the
 * HTTP wiring (res.on('close') → abort, status/json shaping); everything
 * dependency-related lives here and is driven by the passed-in AbortSignal.
 *
 * The caller owns the signal so it can wire client-disconnect abort (the
 * handler) or its own controller (ready route). Returns the per-check results
 * map plus the computed `healthy` flag and whether the overall deadline fired.
 */
export async function runHealthChecks(
  signal: AbortSignal
): Promise<{ healthy: boolean; results: Record<CheckKey, boolean>; deadlineTimedOut: boolean }> {
  // Start the overall deadline at the TOP — before the config-fetch leg — so
  // the timer bounds the WHOLE run (config fetch + checks), not just the check
  // phase. A slow/hung sysRedis config read can no longer consume the budget
  // before checks even start.
  let deadlineTimedOut = false;
  let deadlineId: ReturnType<typeof setTimeout> | undefined;
  const overallDeadlineMs = getOverallDeadlineMs();
  const deadlinePromise = new Promise<void>((resolve) => {
    deadlineId = setTimeout(() => {
      deadlineTimedOut = true;
      resolve();
    }, overallDeadlineMs);
  });

  try {
    // Fetch both config sets in parallel (each internally raced at
    // HEALTHCHECK_TIMEOUT) so a slow sysRedis costs one timeout window, not two
    // serial ones — and race the whole leg against the overall deadline so a
    // hung config read can't burn the budget before checks run. If the deadline
    // fires during the config fetch we degrade SAFELY: treat disabled and
    // non-critical as empty, i.e. run ALL checks and suppress NOTHING.
    let disabledChecks: CheckKey[] = [...envDisabledChecks];
    let nonCriticalChecks: CheckKey[] = [];
    if (isProd) {
      const configReadTimeout = Math.max(
        env.HEALTHCHECK_TIMEOUT,
        Math.floor(overallDeadlineMs / 3)
      );
      const configPromise = Promise.all([
        getHealthcheckConfig(REDIS_SYS_KEYS.SYSTEM.DISABLED_HEALTHCHECKS, configReadTimeout),
        getHealthcheckConfig(REDIS_SYS_KEYS.SYSTEM.NON_CRITICAL_HEALTHCHECKS, configReadTimeout),
      ]).then(([disabled, nonCritical]) => {
        disabledChecks = [...envDisabledChecks, ...disabled];
        nonCriticalChecks = nonCritical;
      });
      await Promise.race([configPromise, deadlinePromise]);
    }

    // Mid-run abort short-circuit (client disconnected during the config-fetch
    // leg). origin/main's handler had this guard inline; the extraction dropped
    // it, so on the probe path — which fires every few seconds — a disconnect no
    // longer stopped the (expensive) DB/Redis/Meili/CH check phase from running
    // to completion. Bail before the checks run. The caller already treats
    // `signal.aborted` after the call as "don't send a response", so the exact
    // values here are inert — return the contract shape with empty results.
    if (signal.aborted) {
      return { healthy: false, results: {} as Record<CheckKey, boolean>, deadlineTimedOut };
    }

    const activeChecks = Object.entries(checkFns).filter(
      ([name]) => !disabledChecks.includes(name as CheckKey)
    );

    // Shared results map. Each check writes its own result as it resolves so
    // that if the overall deadline fires before Promise.all settles, we can
    // still report whatever has resolved, treating the rest as timed-out.
    const results = {} as Record<CheckKey, boolean>;
    const settled = new Set<CheckKey>();
    for (const [name] of activeChecks) results[name as CheckKey] = false;

    const checksPromise = Promise.all(
      activeChecks.map(([name, fn]) =>
        runCheckWithTimeout(fn, signal, env.HEALTHCHECK_TIMEOUT)
          .then(({ result, outcome, durationSeconds }) => {
            if (settled.has(name as CheckKey)) return;
            settled.add(name as CheckKey);
            if (!result) counters[name as CheckKey]?.inc();
            healthcheckAttemptsCounter.inc({ name, result: outcome });
            healthcheckDurationHistogram.observe({ name }, durationSeconds);
            results[name as CheckKey] = result;
          })
          .catch(() => {
            if (settled.has(name as CheckKey)) return;
            settled.add(name as CheckKey);
            healthcheckAttemptsCounter.inc({ name, result: 'failure' });
            results[name as CheckKey] = false;
          })
      )
    );

    // Race the check phase against the SAME overall deadline.
    await Promise.race([checksPromise, deadlinePromise]);

    // Mid-run abort short-circuit (client disconnected during the check race) —
    // the second of origin/main's two inline guards. Skip the deadline-fill +
    // healthy computation + metric bookkeeping; the caller won't send a response
    // anyway. Return whatever has resolved so far in the contract shape.
    if (signal.aborted) {
      return { healthy: false, results, deadlineTimedOut };
    }

    if (deadlineTimedOut) {
      for (const [name] of activeChecks) {
        if (settled.has(name as CheckKey)) continue;
        settled.add(name as CheckKey);
        healthcheckAttemptsCounter.inc({ name, result: 'timeout' });
        counters[name as CheckKey]?.inc();
        healthcheckDurationHistogram.observe({ name }, overallDeadlineMs / 1000);
      }
      logError({
        error: new Error(`Health check overall deadline (${overallDeadlineMs}ms) exceeded`),
        name: 'overall-deadline',
        details: { results },
      });
    }

    const healthy = activeChecks.every(
      ([name]) =>
        // Static soft-dependency exclusion (sysRedis) is unioned in FIRST and
        // independently of the sysRedis-read `nonCriticalChecks`, so it holds
        // even when that config read fails during a real sysRedis outage.
        STATIC_NON_CRITICAL_CHECKS.includes(name as CheckKey) ||
        nonCriticalChecks.includes(name as CheckKey) ||
        results[name as CheckKey]
    );
    if (!healthy) counters.overall?.inc();

    return { healthy, results, deadlineTimedOut };
  } finally {
    // Clear the deadline timer regardless of how we exit so it can't keep the
    // process from settling between requests.
    if (deadlineId !== undefined) clearTimeout(deadlineId);
  }
}

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const podname = process.env.PODNAME ?? getRandomInt(100, 999);

  // Create AbortController for all health checks
  // This will be aborted when the client disconnects
  const abortController = new AbortController();
  const { signal } = abortController;

  // Abort all checks when client disconnects
  const onClose = () => {
    if (!isProd) console.log('Health check request cancelled (client disconnected)');
    abortController.abort();
  };
  res.on('close', onClose);

  // Check if already cancelled before starting the expensive checks.
  if (signal.aborted) {
    res.off('close', onClose);
    return;
  }

  const { healthy, results } = await runHealthChecks(signal);

  // Clean up the close listener
  res.off('close', onClose);

  // If cancelled, don't send response (connection is already closed)
  if (signal.aborted) {
    return;
  }

  return res.status(healthy ? 200 : 500).json({
    podname,
    version: process.env.version,
    healthy,
    ...results,
  });
});

/**
 * Run a cancellable check function with timeout.
 * The signal is passed to the check function for proper cancellation support.
 *
 * Returns the boolean result plus the diagnostic outcome (success/failure/
 * timeout) and wall-clock duration. The outcome distinguishes "the dep
 * returned/threw false" from "Promise.race hit the timeout ceiling" — the
 * timeout path used to be invisible because it just resolved to false.
 */
async function runCheckWithTimeout(
  fn: CancellableCheckFn,
  signal: AbortSignal,
  timeout: number
): Promise<{ result: boolean; outcome: CheckOutcome; durationSeconds: number }> {
  const startNs = process.hrtime.bigint();
  const elapsedSeconds = () => Number(process.hrtime.bigint() - startNs) / 1e9;

  if (signal.aborted) {
    return { result: false, outcome: 'failure', durationSeconds: elapsedSeconds() };
  }

  // Create a combined signal that aborts on either:
  // 1. The parent signal (client disconnect)
  // 2. Timeout
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), timeout);

  // Create a combined abort handler
  const combinedController = new AbortController();
  const abortCombined = () => combinedController.abort();

  signal.addEventListener('abort', abortCombined, { once: true });
  timeoutController.signal.addEventListener('abort', abortCombined, { once: true });

  // Race the check against a hard timeout. Some underlying clients
  // (redis, clickhouse, meili) ignore AbortSignal on simple commands,
  // so signal-only cancellation can hang forever. Promise.race enforces
  // the ceiling regardless of signal support.
  //
  // Tag each branch of the race so the outer code can tell which one won
  // — "timeout" vs "fn returned false" used to be indistinguishable.
  const timeoutPromise = new Promise<{ kind: 'timeout' }>((resolve) => {
    timeoutController.signal.addEventListener('abort', () => resolve({ kind: 'timeout' }), {
      once: true,
    });
  });
  const fnPromise = fn(combinedController.signal).then(
    (value) => ({ kind: 'value' as const, value }),
    () => ({ kind: 'error' as const })
  );

  try {
    const race = await Promise.race([fnPromise, timeoutPromise]);
    if (race.kind === 'timeout') {
      return { result: false, outcome: 'timeout', durationSeconds: elapsedSeconds() };
    }
    if (race.kind === 'error') {
      return { result: false, outcome: 'failure', durationSeconds: elapsedSeconds() };
    }
    return {
      result: race.value,
      outcome: race.value ? 'success' : 'failure',
      durationSeconds: elapsedSeconds(),
    };
  } finally {
    clearTimeout(timeoutId);
    signal.removeEventListener('abort', abortCombined);
  }
}

/**
 * Get healthcheck config from Redis with timeout.
 *
 * `maxTimeout` lets a caller tighten the per-read ceiling below the default
 * HEALTHCHECK_TIMEOUT. The /api/health handler passes a sub-budget so the
 * config-fetch leg can never structurally consume the whole overall deadline
 * and starve the actual checks (which would seed every check `false` → false
 * 500 on a healthy pod). Other callers omit it and keep the original behavior.
 */
async function getHealthcheckConfig(key: string, maxTimeout?: number): Promise<CheckKey[]> {
  const timeout = maxTimeout ?? env.HEALTHCHECK_TIMEOUT;
  try {
    const value = await Promise.race([
      sysRedis.hGet(REDIS_SYS_KEYS.SYSTEM.FEATURES, key),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeout)),
    ]);
    return JSON.parse(value ?? '[]') as CheckKey[];
  } catch {
    return [];
  }
}
