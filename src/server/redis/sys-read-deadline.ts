import { env } from '~/env/server';
import { sysReadGuard } from '~/server/redis/sys-read-breaker';

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
 * NOTE: this only bounds the awaited READ it wraps. Awaited sys WRITES on a half-open
 * are not raced here — they are bounded by `commandsQueueMaxLength` (heap) and are
 * fail-open / best-effort at their call sites.
 *
 * The deadline alone: it never consults the read breaker (see withSysReadBreaker). A
 * timeout rejects with a SysReadUnavailableError whose message says "timed out", and is
 * counted in sys_read_guard_failopen_total.
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
