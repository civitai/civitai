/**
 * In-process record of SYS (sysRedis / Sentinel) command TIMEOUTS and the last SUCCESS — the
 * signal behind the sys self-heal's timeout-rate trigger. The sys mirror of ./cluster-deadline-hits.
 *
 * WHY (2026-10-18): the sys watchdog's only trigger was in-flight count staying above
 * REDIS_SYS_SELFHEAL_INFLIGHT_THRESHOLD (500). The per-command backstop (REDIS_SYS_COMMAND_TIMEOUT_MS,
 * 30 s) releases each caller after 30 s, so a wedged client never holds more than roughly
 * `command rate × 30 s` commands in flight. A low-traffic app sits far below 500 even when every
 * one of its sys commands hangs, so it NEVER self-healed: a wedged Sentinel client leaked for about
 * an hour until the process ran out of memory, while every sys command timed out and no reconnect
 * happened. A timeout RATE does not depend on traffic volume the way an in-flight level does.
 *
 * THE SIGNAL: `countSysTimeoutsWithoutSuccess(windowMs)` is the number of timeouts in the last
 * `windowMs`, or 0 if ANY sys command succeeded in that window. The "no success" half is the
 * false-positive guard: a healthy client that times out the odd slow command keeps succeeding
 * at everything else, so it reads 0 however many slow commands it has. Only a client on which
 * nothing at all completes reads above 0.
 *
 * "Success" = the underlying command FULFILLED, even if its caller had already been released by
 * the backstop: a late reply still proves the client is talking to the server, and reconnecting a
 * client that is merely slow would only add load to a slow server. A rejected command (a Redis
 * error reply, a dropped connection) is neither a success nor a timeout.
 *
 * Aggregate across every 'sys' base connection (serving + Buffer-mode), like ./sys-inflight: the
 * sys self-heal reconnects all of them together, so one healthy connection holds the heal off.
 *
 * Pure (no redis/prom imports) so it can be unit-tested and sampled without a prom dependency.
 */

// Bounded ring of recent timeout timestamps (ms); once full the oldest entry is overwritten. The
// trigger threshold is far below the capacity, so losing older-than-window entries loses nothing.
const RING_CAPACITY = 512;
const ring: number[] = [];
let writeIdx = 0;
let lastSuccessAt: number | null = null;

/** Record one sys command that hit the per-command backstop. `now` injectable for tests. */
export function recordSysCommandTimeout(now: number = Date.now()): void {
  if (ring.length < RING_CAPACITY) {
    ring.push(now);
  } else {
    ring[writeIdx] = now;
    writeIdx = (writeIdx + 1) % RING_CAPACITY;
  }
}

/** Record one sys command whose underlying call fulfilled. `now` injectable for tests. */
export function recordSysCommandSuccess(now: number = Date.now()): void {
  lastSuccessAt = now;
}

/**
 * Timeouts recorded within the last `windowMs` (timestamp > now - windowMs), or 0 when a sys
 * command succeeded within that same window. O(RING_CAPACITY) at a 1 s watchdog sample.
 */
export function countSysTimeoutsWithoutSuccess(windowMs: number, now: number = Date.now()): number {
  const cutoff = now - windowMs;
  if (lastSuccessAt != null && lastSuccessAt > cutoff) return 0;
  let count = 0;
  for (let i = 0; i < ring.length; i++) {
    if (ring[i] > cutoff) count++;
  }
  return count;
}

/**
 * Clear the record. The sys watchdog calls this when it triggers a reconnect, so the timeouts that
 * caused one heal cannot count towards the next; also used by tests.
 */
export function resetSysTimeouts(): void {
  ring.length = 0;
  writeIdx = 0;
  lastSuccessAt = null;
}
