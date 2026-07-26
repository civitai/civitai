import { describe, expect, it } from 'vitest';
import { L1_CACHE_BYTE_BUDGETS, L1_TOTAL_BYTE_CEILING } from '../l1-cache-budget';

/**
 * Heap-safety invariant for the per-pod L1 (in-process LRU) caches in caches.ts.
 *
 * Each L1 cache is individually byte-bounded via `localMaxBytes`, sourced from
 * L1_CACHE_BYTE_BUDGETS (single source of truth). The SUM of those budgets is the
 * pod's total worst-case L1 footprint and MUST stay under the hard ceiling — this is
 * the regression guard that stops someone adding/enlarging an L1 cache from silently
 * blowing the dp-prod pod heap (4096MB old-space, >3200MB heap-headroom alert).
 */
describe('L1 cache byte budget', () => {
  const sum = Object.values(L1_CACHE_BYTE_BUDGETS).reduce((a, b) => a + b, 0);

  it('sum of all per-pod L1 byte budgets stays under the hard ceiling', () => {
    expect(sum).toBeLessThanOrEqual(L1_TOTAL_BYTE_CEILING);
  });

  it('ceiling is a small fraction of the 4096MB pod old-space limit (heap safety)', () => {
    const OLD_SPACE_LIMIT = 4096 * 1024 * 1024;
    // Keep the total L1 footprint well under 5% of old-space so it can never be a
    // meaningful contributor to a heap-headroom breach.
    expect(L1_TOTAL_BYTE_CEILING).toBeLessThan(OLD_SPACE_LIMIT * 0.05);
  });

  it('every budget is a positive integer number of bytes', () => {
    for (const [name, bytes] of Object.entries(L1_CACHE_BYTE_BUDGETS)) {
      expect(bytes, name).toBeGreaterThan(0);
      expect(Number.isInteger(bytes), name).toBe(true);
    }
  });
});
