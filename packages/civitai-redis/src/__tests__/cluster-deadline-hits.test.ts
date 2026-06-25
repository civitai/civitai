import { describe, it, expect, beforeEach } from 'vitest';
import {
  countClusterDeadlineHits,
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
