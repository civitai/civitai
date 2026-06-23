import { env } from '~/env/server';

/**
 * Wall-clock deadline for ANY per-request sysRedis READ (single command OR MULTI).
 *
 * The sys client carries no socketTimeout (REDIS_SYS_SOCKET_TIMEOUT_MS defaults to 0,
 * to avoid the reconnect-storm wedge on the single-replica backend). A per-command
 * timeout does NOT bound a command once it's been WRITTEN (its AbortSignal is disarmed
 * at write time) and never bounds MULTI sub-commands. So on a SILENT half-open (client
 * still believes it's connected) a written sys command parks in node-redis's reply
 * queue until OS TCP keepalive errors the socket (Linux defaults ≈ 11min) on EVERY
 * authenticated request. This wall-clock race bounds the *read* handler wait regardless
 * of where the command parks; on timeout it rejects so the caller's fail-open keeps
 * serving. The orphaned command settles in the background (its stray rejection is reaped
 * by Promise.race) and is capped by the sys client's `commandsQueueMaxLength`;
 * `disableOfflineQueue` keeps the reconnect path clear.
 *
 * NOTE: this only bounds the awaited READ it wraps. Awaited sys WRITES on a half-open
 * are not raced here — they are bounded by `commandsQueueMaxLength` (heap) and are
 * fail-open / best-effort at their call sites.
 *
 * `ms` defaults to REDIS_SYS_READ_TIMEOUT_MS; pass an explicit value in tests. `<= 0`
 * disables the guard (returns the promise unchanged).
 */
export function withSysReadDeadline<T>(
  p: Promise<T>,
  ms: number = env.REDIS_SYS_READ_TIMEOUT_MS
): Promise<T> {
  if (!ms || ms <= 0) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sysRedis read timed out after ${ms}ms`)), ms);
  });
  // Timer is always cleared in finally() (within `ms`), so no unref() is needed.
  return Promise.race([p, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
