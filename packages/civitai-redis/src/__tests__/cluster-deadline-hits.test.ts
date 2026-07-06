import { describe, it, expect, beforeEach } from 'vitest';
import {
  countClusterDeadlineHits,
  recordClusterCommandSettle,
  recordClusterDeadlineHit,
  resetClusterDeadlineHits,
} from '../cluster-deadline-hits';

// cluster-deadline-hits is the sliding-window recorder of CLUSTER command-deadline TIMEOUTS —
// the sawtooth-immune self-heal trigger signal. A healthy client records ZERO hits; a half-open
// client records one per deadline-rejected command. The watchdog samples a windowed count.
// Module-scoped state → reset before each test.

describe('cluster-deadline-hits', () => {
  beforeEach(() => resetClusterDeadlineHits());

  it('counts hits recorded inside the window', () => {
    recordClusterDeadlineHit(1000);
    recordClusterDeadlineHit(1500);
    recordClusterDeadlineHit(2000);
    // window covering [1000..2000] from now=2000, windowMs=2000 → cutoff=0, all 3 counted
    expect(countClusterDeadlineHits(2000, 2000)).toBe(3);
  });

  it('excludes hits older than the window (strictly greater than cutoff)', () => {
    recordClusterDeadlineHit(0);
    recordClusterDeadlineHit(5000);
    recordClusterDeadlineHit(9000);
    // now=10000, windowMs=2000 → cutoff=8000 → only the 9000 hit counts
    expect(countClusterDeadlineHits(2000, 10000)).toBe(1);
  });

  it('returns 0 for a healthy client (no hits recorded)', () => {
    expect(countClusterDeadlineHits(20000, 50000)).toBe(0);
  });

  it('reset clears the window', () => {
    recordClusterDeadlineHit(1000);
    recordClusterDeadlineHit(1100);
    expect(countClusterDeadlineHits(10000, 2000)).toBe(2);
    resetClusterDeadlineHits();
    expect(countClusterDeadlineHits(10000, 2000)).toBe(0);
  });

  it('bounds memory: keeps counting recent hits even past the ring capacity', () => {
    // Record far more than RING_CAPACITY (512) hits, all within the window. The ring overwrites
    // the oldest, but the count is capped at capacity — which is far above any trigger threshold,
    // so the wedge is still detected. This proves a sustained wedge can't grow memory unbounded.
    const now = 1_000_000;
    for (let i = 0; i < 2000; i++) recordClusterDeadlineHit(now);
    const count = countClusterDeadlineHits(20000, now + 1);
    expect(count).toBeGreaterThanOrEqual(512); // saturated at capacity
    expect(count).toBeLessThanOrEqual(512); // never exceeds capacity (bounded)
  });

  it('a sustained wedge keeps the windowed count high even as old hits age out', () => {
    // Hits arriving steadily: at t=20000 with windowMs=10000, only hits in (10000,20000] count.
    for (let t = 0; t <= 20000; t += 1000) recordClusterDeadlineHit(t);
    // hits at 11000..20000 = 10 of them
    expect(countClusterDeadlineHits(10000, 20000)).toBe(10);
  });
});

// recordClusterCommandSettle is the SETTLE-TIME recorder (the 2026-07-06 fix): instrumentCommands'
// done() calls it for the cluster client with the command's OBSERVED duration. It records a hit iff
// duration >= the slow threshold — the SAME observation the redis_command_duration histogram uses,
// so the watchdog's ring can never diverge from the histogram that proves a wedge (the old
// onTimeout-only recorder went silent whenever the deadline didn't reap the command).
describe('recordClusterCommandSettle (settle-time slow-command recorder)', () => {
  beforeEach(() => resetClusterDeadlineHits());

  it('records a hit when the observed duration reaches the slow threshold', () => {
    recordClusterCommandSettle(10000, 10000, 1000); // exactly at threshold → recorded
    recordClusterCommandSettle(29000, 10000, 1100); // the ~29s incident tail → recorded
    expect(countClusterDeadlineHits(20000, 1200)).toBe(2);
  });

  it('does NOT record a fast (healthy) command below the threshold', () => {
    recordClusterCommandSettle(23, 10000, 1000); // healthy p99 ≈ 23ms
    recordClusterCommandSettle(9999, 10000, 1000); // just under the threshold
    expect(countClusterDeadlineHits(20000, 1000)).toBe(0);
  });

  it('is inert when the slow threshold is <= 0 (recording disabled)', () => {
    recordClusterCommandSettle(60000, 0, 1000);
    recordClusterCommandSettle(60000, -1, 1000);
    expect(countClusterDeadlineHits(20000, 1000)).toBe(0);
  });

  it('accumulates a wedge: ~4/s slow settles over 20s far exceed the 10-hit trigger threshold', () => {
    // Reproduces the incident RATE (per pod): a slow settle every 250ms for 20s = 80 hits, 8× the
    // default deadlineHitThreshold of 10. This is the sawtooth-immune signal the watchdog samples.
    for (let t = 0; t < 20000; t += 250) recordClusterCommandSettle(29000, 10000, t);
    expect(countClusterDeadlineHits(20000, 20000)).toBeGreaterThanOrEqual(10);
  });
});
