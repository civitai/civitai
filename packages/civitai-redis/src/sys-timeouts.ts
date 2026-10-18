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
 * THE SIGNAL: each sys base connection (serving + Buffer-mode) keeps its OWN record (one per
 * `instrumentCommands` call). A record reads as the number of its timeouts in the last `windowMs`,
 * or 0 if any of ITS commands succeeded in that window; `countSysTimeoutsWithoutSuccess` is the
 * highest reading across records. The "no success" half is the false-positive guard: a healthy
 * client that times out the odd slow command keeps succeeding at everything else, so it reads 0
 * however many slow commands it has. Per connection, not aggregate, so a wedged connection still
 * heals while the other keeps answering; the heal reconnects all of them, as before.
 *
 * "Success" = the underlying command FULFILLED, even if its caller had already been released by
 * the backstop: a late reply still proves the client is talking to the server, and reconnecting a
 * client that is merely slow would only add load to a slow server. A rejected command (a Redis
 * error reply, a dropped connection) is neither a success nor a timeout.
 *
 * Pure (no redis/prom imports) so it can be unit-tested and sampled without a prom dependency.
 */

// Capacity of each record's ring of recent timeout timestamps (ms); once full the oldest entry is
// overwritten, so a reading tops out at 512 — still far above any sane threshold.
const RING_CAPACITY = 512;

/** One sys base connection's timeouts and last success. */
export interface SysTimeoutRecord {
  /** Record one command that hit the per-command backstop. `now` injectable for tests. */
  recordTimeout(now?: number): void;
  /** Record one command whose underlying call fulfilled. `now` injectable for tests. */
  recordSuccess(now?: number): void;
  /** Timeouts with timestamp > now - windowMs, or 0 when a command succeeded in that window. */
  count(windowMs: number, now?: number): number;
  reset(): void;
}

// Every record created in this process (one per instrumented sys connection — two at most per
// sys client), read together by the watchdog.
const records = new Set<SysTimeoutRecord>();

/** Create (and register for the watchdog) the record for one sys base connection. */
export function createSysTimeoutRecord(): SysTimeoutRecord {
  const ring: number[] = [];
  let writeIdx = 0;
  let lastSuccessAt: number | null = null;
  const record: SysTimeoutRecord = {
    recordTimeout(now = Date.now()) {
      if (ring.length < RING_CAPACITY) {
        ring.push(now);
      } else {
        ring[writeIdx] = now;
        writeIdx = (writeIdx + 1) % RING_CAPACITY;
      }
    },
    recordSuccess(now = Date.now()) {
      lastSuccessAt = now;
    },
    count(windowMs, now = Date.now()) {
      const cutoff = now - windowMs;
      if (lastSuccessAt != null && lastSuccessAt > cutoff) return 0;
      let n = 0;
      for (let i = 0; i < ring.length; i++) {
        if (ring[i] > cutoff) n++;
      }
      return n;
    },
    reset() {
      ring.length = 0;
      writeIdx = 0;
      lastSuccessAt = null;
    },
  };
  records.add(record);
  return record;
}

/**
 * The highest reading across every sys connection's record: the trigger input the sys watchdog
 * samples. O(records × RING_CAPACITY) at a 1 s watchdog sample.
 */
export function countSysTimeoutsWithoutSuccess(windowMs: number, now: number = Date.now()): number {
  let max = 0;
  for (const r of records) max = Math.max(max, r.count(windowMs, now));
  return max;
}

/**
 * Clear every record. The sys watchdog calls this when it triggers a reconnect, so the timeouts
 * that caused one heal cannot count towards the next.
 */
export function resetSysTimeouts(): void {
  for (const r of records) r.reset();
}
