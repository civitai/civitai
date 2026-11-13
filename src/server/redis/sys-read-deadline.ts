import { env } from '~/env/server';
import {
  sysReadBreakerTransitionCounter,
  sysReadGuardRejectionCounter,
} from '~/server/prom/sys-read-guard.metrics';
import {
  createCircuitBreaker,
  createSysReadGuard,
  type CircuitBreaker,
  type SysReadGuardConfig,
} from '~/server/redis/sys-read-breaker';

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var __civitaiSysReadBreaker: CircuitBreaker | undefined;
}

/** Read per call, so a changed env (or a test's setEnv) applies without rebuilding the guard. */
function sysReadGuardConfigFromEnv(): SysReadGuardConfig {
  return {
    breakerEnabled: env.REDIS_SYS_READ_BREAKER_ENABLED === true,
    breaker: {
      threshold: env.REDIS_SYS_READ_BREAKER_THRESHOLD,
      cooldownMs: env.REDIS_SYS_READ_BREAKER_COOLDOWN_MS,
    },
  };
}

// The process-wide guard and its breaker (globalThis, because the server evaluates this module once per
// bundler module graph). NOT exported: withSysReadBreaker below is the only way to reach the breaker, so the
// call-site ledger (sys-read-breaker.call-site-ledger.test.ts) sees every opted-in read.
const sysReadGuard = createSysReadGuard({
  config: sysReadGuardConfigFromEnv,
  breaker: (globalThis.__civitaiSysReadBreaker ??= createCircuitBreaker((to) =>
    sysReadBreakerTransitionCounter.inc({ to })
  )),
  onFailure: (reason) => sysReadGuardRejectionCounter.inc({ reason }),
});

/**
 * Wall-clock deadline for ANY per-request sysRedis READ (single command OR MULTI).
 *
 * The sys client carries no socketTimeout (REDIS_SYS_SOCKET_TIMEOUT_MS defaults to 0,
 * to avoid the reconnect-storm wedge on the single-replica backend). A per-command
 * timeout does NOT bound a command once it's been WRITTEN (its AbortSignal is disarmed
 * at write time) and never bounds MULTI sub-commands. So on a SILENT half-open a written
 * sys command parks in node-redis's reply queue until the client's own per-command
 * backstop or OS TCP keepalive errors it, on EVERY authenticated request. This wall-clock
 * race bounds the *read* handler wait regardless of where the command parks; on timeout it
 * rejects so the caller's fail-open keeps serving. The orphaned command settles in the
 * background (its stray rejection is reaped by Promise.race) and is capped by the sys
 * client's `commandsQueueMaxLength`; `disableOfflineQueue` keeps the reconnect path clear.
 *
 * NOTE: it bounds only the awaited command it wraps. Most awaited sys WRITES are not wrapped:
 * on a half-open they are bounded only by `commandsQueueMaxLength` (heap), and their call
 * sites treat them as best-effort. A write whose outcome a caller acts on can be wrapped too:
 * `recordUploadKeyOwner` races its upload key issue record so a stalled write counts as failed.
 *
 * The deadline alone: it never consults the read breaker (see withSysReadBreaker). A
 * timeout rejects with a SysReadUnavailableError whose message says "timed out", and is
 * counted in sys_read_guard_rejections_total.
 *
 * `ms` defaults to REDIS_SYS_READ_TIMEOUT_MS; pass an explicit value in tests. `<= 0`
 * disables the guard (returns the promise unchanged).
 */
export function withSysReadDeadline<T>(
  p: Promise<T>,
  ms: number = env.REDIS_SYS_READ_TIMEOUT_MS
): Promise<T> {
  return sysReadGuard.deadline(p, ms);
}

/**
 * withSysReadDeadline plus the process-wide read breaker (./sys-read-breaker.ts), for the
 * hot reads a hung store multiplies per request. With REDIS_SYS_READ_BREAKER_ENABLED off
 * (the default) it is withSysReadDeadline exactly. Once the breaker has tripped it rejects
 * at once with a SysReadUnavailableError('breaker-open'); the command was already issued
 * and still reaches the client.
 *
 * Only for READS that FAIL OPEN and run on every request. Never for a write, and never for
 * a read whose failure must fail closed: during the breaker's cooldown it refuses reads the
 * store would have answered.
 */
export function withSysReadBreaker<T>(
  p: Promise<T>,
  ms: number = env.REDIS_SYS_READ_TIMEOUT_MS
): Promise<T> {
  return sysReadGuard.withBreaker(p, ms);
}
