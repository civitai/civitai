/**
 * In-process sliding-window count of CLUSTER (cache) command SLOW-SETTLES — the sawtooth-immune
 * self-heal trigger signal (see cluster-selfheal.ts). "Slow settle" = a cluster command whose
 * OBSERVED wall-clock duration reached the slow threshold (recordClusterCommandSettle, wired from
 * instrumentCommands' done()). A healthy client records ZERO; a half-open one records ~one per
 * wedged command.
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
 * THE FIX: trigger self-heal on a signal the deadline-drain CANNOT erase — the RATE of SLOW
 * SETTLES itself. A healthy cluster client NEVER settles a command slowly (healthy p99 ≈ 23ms);
 * a half-open client settles ~every command slowly (the drains ARE the slow settles). So "N slow
 * settles within the last W ms" is a monotonic, sawtooth-immune "this client is wedged" signal.
 * This module is the in-process recorder for that signal: a tiny bounded ring of hit timestamps
 * with a windowed-count read.
 *
 * WHY SLOW-SETTLE, NOT deadline-TIMEOUT (2026-07-06 fleet-wide wedge — human recycle,
 * selfheal 0-fire): the recorder was originally fed ONLY by `withCommandDeadline`'s onTimeout,
 * i.e. it counted a hit ONLY when the per-command deadline REAPED a still-hanging command. But
 * the deadline-hit trigger keyed off that is silent whenever the deadline does NOT reap — during
 * the 2026-07-06 wedge the slow cluster commands SETTLED on their own well past the deadline
 * (~29s tail; requests hung ~29s), so the 15s timer never reaped them, onTimeout never fired, and
 * this ring stayed EMPTY — even though `redis_command_duration_seconds` (the histogram the
 * external wedge-relief keyed off) plainly showed ~4/s commands over 15s. Signal mismatch: the
 * histogram observes at SETTLE time (done()), the ring was observing at REAP time (onTimeout), and
 * the two diverge exactly when the deadline isn't reaping. The recorder is now fed from the SAME
 * settle-time observation as the histogram, so the watchdog can never again be blind to a wedge
 * the histogram can see.
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
 * Record one cluster wedge hit (a slow settle). Prefer recordClusterCommandSettle from the hot
 * path — this is the raw ring writer it delegates to, kept exported for direct unit tests.
 * `now` is injectable for tests; defaults to Date.now.
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
 * Record a cluster command's SETTLE as a wedge hit iff its observed wall-clock duration reached
 * `slowThresholdMs`. Wired from instrumentCommands' done() for the CLUSTER client only, using the
 * SAME `Date.now() - start` the `redis_command_duration_seconds` histogram observes — so the
 * watchdog's ring can never diverge from the histogram that proves a wedge (the 2026-07-06 bug:
 * onTimeout-only recording stayed empty while the histogram showed ~4/s > 15s commands, because
 * the slow commands SETTLED past the deadline rather than being REAPED by it).
 *
 * Sawtooth-immune: it counts slow SETTLES (a rate), not an inflight level, so the per-command
 * deadline draining inflight every ~15s cannot erase it (each drain IS a slow settle → a hit).
 * Independent of whether the deadline reaper is enabled: a command that hangs and is reaped at the
 * deadline settles at ~deadlineMs (>= threshold → recorded); a command that settles on its own at
 * ~29s is likewise recorded. `slowThresholdMs <= 0` disables recording. `now` injectable for tests.
 */
export function recordClusterCommandSettle(
  durationMs: number,
  slowThresholdMs: number,
  now: number = Date.now()
): void {
  if (slowThresholdMs > 0 && durationMs >= slowThresholdMs) {
    recordClusterDeadlineHit(now);
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
