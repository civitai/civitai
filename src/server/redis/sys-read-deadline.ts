import { env } from '~/env/server';
import { raceSysDeadline, sysReadGuard, type SysReadOp } from '~/server/redis/sys-read-breaker';

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
 * With REDIS_SYS_READ_BREAKER_ENABLED, reads also go through a process-wide breaker that,
 * after repeated failures, rejects at once instead of waiting out the deadline on every read
 * (./sys-read-breaker.ts). It is off by default, and while off this is the deadline alone.
 * The rejection is a SysReadUnavailableError whose message says "timed out" on the deadline.
 *
 * Takes the command's promise (every existing call site) or a thunk that issues it; a thunk
 * is not invoked while the breaker is open. See sys-read-breaker.ts for why the existing
 * call sites keep the promise form.
 *
 * READS ONLY. A call with a side effect, or a read whose failure decides a security/authz
 * or moderation outcome, uses `withSysDeadline` below — the same deadline, never refused by
 * the breaker.
 *
 * `ms` defaults to REDIS_SYS_READ_TIMEOUT_MS; pass an explicit value in tests. `<= 0`
 * disables the deadline (with the breaker off, returns the promise unchanged).
 */
export function withSysReadDeadline<T>(
  p: SysReadOp<T>,
  ms: number = env.REDIS_SYS_READ_TIMEOUT_MS
): Promise<T> {
  return sysReadGuard(p, ms);
}

/**
 * The deadline alone, for sysRedis calls the read breaker must never refuse: writes, MULTIs
 * that write, EVALs, destructive pops, and reads whose failure decides a security/authz or
 * moderation outcome. It bounds how long the caller waits and changes nothing else: the
 * command is not cancelled, and a late rejection is reaped. `<= 0` disables it (returns the
 * promise unchanged). Defaults to REDIS_SYS_READ_TIMEOUT_MS like withSysReadDeadline.
 */
export function withSysDeadline<T>(
  p: Promise<T>,
  ms: number = env.REDIS_SYS_READ_TIMEOUT_MS
): Promise<T> {
  return raceSysDeadline(p, ms);
}
