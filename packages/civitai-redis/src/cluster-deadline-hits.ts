/**
 * In-process sliding-window count of CLUSTER (cache) command-deadline TIMEOUTS
 * (the second self-heal trigger signal — see cluster-selfheal.ts).
 *
 * WHY THIS EXISTS (the bug it fixes): the original self-heal watchdog (FIX #1) triggered
 * ONLY on `redis_commands_inflight{client="cluster"}` staying CONTINUOUSLY above a
 * threshold for `REDIS_CLUSTER_SELFHEAL_SUSTAINED_MS` (20s). But the per-command deadline
 * (`withCommandDeadline`, REDIS_CLUSTER_COMMAND_TIMEOUT_MS = 15s) REJECTS every parked
 * command at ~15s and dec's the inflight counter. During a real half-open park the parked
 * commands share roughly the same age, so they reject in a batch every ~15s → inflight
 * SAWTOOTHS between ~200 and ~0. Each crash below the threshold resets the watchdog's
 * sustained-breach timer (cluster-selfheal.ts line "inflight <= threshold → breachStartedAt
 * = null"). Because the deadline (15s) is SHORTER than the sustained window (20s), the
 * breach timer can never accumulate 20 continuous seconds → self-heal NEVER fires. This was
 * confirmed live: 21 pods wedged to inflight≈200 for 6–12 min while
 * `civitai_app_redis_selfheal_reconnect_total` stayed 0 across the whole fleet.
 *
 * THE FIX: trigger self-heal on a signal the deadline-drain CANNOT erase — the RATE of
 * deadline timeouts itself. A healthy cluster client NEVER hits the 15s deadline (healthy
 * p99 ≈ 23ms); a half-open client hits it constantly (the drains ARE the hits). So "N
 * deadline timeouts within the last W ms" is a monotonic, sawtooth-immune "this client is
 * wedged" signal. This module is the in-process recorder for that signal: a tiny bounded
 * ring of timeout timestamps with a windowed-count read.
 *
 * Pure (no redis/prom imports) so it is unit-testable in isolation and so the watchdog can
 * sample it without a prom dependency — mirroring cluster-inflight.ts. One cluster client per
 * process → a module-scoped recorder is correct.
 */

// Bounded ring of recent deadline-timeout timestamps (ms). Bounded so a sustained wedge
// can't grow this unbounded: once full we overwrite the oldest entry. The window read only
// ever cares about the last RING_CAPACITY hits inside the window, and the trigger threshold
// is far below the capacity, so overwriting older-than-window entries loses nothing useful.
const RING_CAPACITY = 512;
const ring: number[] = [];
let writeIdx = 0;

/**
 * Record one cluster command-deadline timeout. Called by withCommandDeadline's onTimeout
 * hook (cluster client only). `now` is injectable for tests; defaults to Date.now.
 */
export function recordClusterDeadlineHit(now: number = Date.now()): void {
  if (ring.length < RING_CAPACITY) {
    ring.push(now);
  } else {
    ring[writeIdx] = now;
    writeIdx = (writeIdx + 1) % RING_CAPACITY;
  }
}

/**
 * Count deadline timeouts recorded within the last `windowMs` (i.e. timestamp > now-windowMs).
 * O(RING_CAPACITY) — trivial at a 1s watchdog sample. `now` injectable for tests.
 */
export function countClusterDeadlineHits(windowMs: number, now: number = Date.now()): number {
  const cutoff = now - windowMs;
  let count = 0;
  for (let i = 0; i < ring.length; i++) {
    if (ring[i] > cutoff) count++;
  }
  return count;
}

/** Reset the ring (used after a self-heal reconnect so the post-heal window starts clean, and in tests). */
export function resetClusterDeadlineHits(): void {
  ring.length = 0;
  writeIdx = 0;
}
