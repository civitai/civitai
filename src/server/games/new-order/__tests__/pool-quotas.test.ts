import { describe, it, expect } from 'vitest';
import { computePoolTargets, DEFAULT_POOL_QUOTAS } from '~/server/games/new-order/pool-quotas';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';

describe('computePoolTargets', () => {
  it('splits evenly across three pools when weights sum to 1 and all pools have stock', () => {
    const { targets, activeIdxs } = computePoolTargets({
      weights: [0.5, 0.5, 0],
      poolSizes: [100, 100, 100],
      overflowLimit: 40,
    });

    expect(activeIdxs).toEqual([0, 1]);
    expect(targets).toEqual([20, 20, 0]);
  });

  it('skips pools whose weight is 0', () => {
    const { targets, activeIdxs } = computePoolTargets({
      weights: [1, 0, 0],
      poolSizes: [100, 100, 100],
      overflowLimit: 40,
    });

    expect(activeIdxs).toEqual([0]);
    expect(targets).toEqual([40, 0, 0]);
  });

  it('skips pools that are empty even when weight is non-zero', () => {
    const { targets, activeIdxs } = computePoolTargets({
      weights: [0.5, 0.5, 0],
      poolSizes: [0, 100, 0],
      overflowLimit: 40,
    });

    // Knight1 has weight but no stock — full quota shifts to Knight2.
    expect(activeIdxs).toEqual([1]);
    expect(targets).toEqual([0, 40, 0]);
  });

  it('honors asymmetric weights and pushes floor() remainder to the heaviest pool', () => {
    const { targets, activeIdxs } = computePoolTargets({
      weights: [0.7, 0.3, 0],
      poolSizes: [100, 100, 100],
      overflowLimit: 20,
    });

    // floor(20 * 0.7) = 14, floor(20 * 0.3) = 6, sum = 20 → no remainder.
    expect(activeIdxs).toEqual([0, 1]);
    expect(targets).toEqual([14, 6, 0]);
  });

  it('distributes flooring remainder to the highest-weight active pool', () => {
    const { targets } = computePoolTargets({
      weights: [0.34, 0.33, 0.33],
      poolSizes: [100, 100, 100],
      overflowLimit: 10,
    });

    // floor(10 * 0.34) = 3, floor(10 * 0.33) = 3 (x2) → sum = 9, remainder = 1.
    // Remainder lands on index 0 (largest weight).
    expect(targets.reduce((a, b) => a + b, 0)).toBe(10);
    expect(targets[0]).toBe(4);
    expect(targets[1]).toBe(3);
    expect(targets[2]).toBe(3);
  });

  it('returns empty active list when all weights are zero', () => {
    const { targets, activeIdxs } = computePoolTargets({
      weights: [0, 0, 0],
      poolSizes: [100, 100, 100],
      overflowLimit: 40,
    });

    expect(activeIdxs).toEqual([]);
    expect(targets).toEqual([0, 0, 0]);
  });

  it('returns empty active list when overflowLimit is zero', () => {
    const { targets, activeIdxs } = computePoolTargets({
      weights: [0.5, 0.5, 0],
      poolSizes: [100, 100, 100],
      overflowLimit: 0,
    });

    expect(activeIdxs).toEqual([]);
    expect(targets).toEqual([0, 0, 0]);
  });

  it('renormalizes when one active pool drops out, keeping totals at overflowLimit', () => {
    const { targets } = computePoolTargets({
      weights: [0.5, 0.5, 0],
      poolSizes: [0, 200, 0],
      overflowLimit: 40,
    });

    expect(targets[1]).toBe(40);
    expect(targets[0]).toBe(0);
    expect(targets[2]).toBe(0);
  });

  it('handles unnormalized weights (e.g. raw 7/3 ratio)', () => {
    const { targets } = computePoolTargets({
      weights: [7, 3, 0],
      poolSizes: [100, 100, 100],
      overflowLimit: 20,
    });

    // 20 * 7/10 = 14, 20 * 3/10 = 6.
    expect(targets).toEqual([14, 6, 0]);
  });

  it('treats NaN/Infinity/non-number weights as zero (defends against corrupted Redis blobs)', () => {
    const { targets, activeIdxs } = computePoolTargets({
      weights: [NaN, Infinity, 0.5] as unknown as number[],
      poolSizes: [100, 100, 100],
      overflowLimit: 20,
    });
    // Only index 2 has a finite positive weight, so it absorbs the full quota.
    expect(activeIdxs).toEqual([2]);
    expect(targets).toEqual([0, 0, 20]);
  });

  it('treats string/null weights as zero without throwing', () => {
    const { targets, activeIdxs } = computePoolTargets({
      weights: ['0.5' as unknown as number, null as unknown as number, 1],
      poolSizes: [100, 100, 100],
      overflowLimit: 20,
    });
    expect(activeIdxs).toEqual([2]);
    expect(targets).toEqual([0, 0, 20]);
  });

  it('treats negative weights as zero', () => {
    const { targets, activeIdxs } = computePoolTargets({
      weights: [-0.5, 0.5, 0],
      poolSizes: [100, 100, 100],
      overflowLimit: 20,
    });
    expect(activeIdxs).toEqual([1]);
    expect(targets).toEqual([0, 20, 0]);
  });

  it('returns empty targets when overflowLimit is non-finite', () => {
    const { targets, activeIdxs } = computePoolTargets({
      weights: [0.5, 0.5, 0],
      poolSizes: [100, 100, 100],
      overflowLimit: Number.NaN,
    });
    expect(activeIdxs).toEqual([]);
    expect(targets).toEqual([0, 0, 0]);
  });

  it('sizes targets to the longer of weights/poolSizes (caller may pass mismatched arrays)', () => {
    // weights shorter than poolSizes — extra pools default to 0 target.
    const { targets, activeIdxs } = computePoolTargets({
      weights: [0.5, 0.5],
      poolSizes: [100, 100, 50],
      overflowLimit: 20,
    });
    expect(targets).toHaveLength(3);
    expect(targets[2]).toBe(0);
    expect(activeIdxs).toEqual([0, 1]);

    // poolSizes shorter than weights — weight-only pools stay inactive.
    const r = computePoolTargets({
      weights: [0.5, 0.5, 0.5],
      poolSizes: [100, 100],
      overflowLimit: 20,
    });
    expect(r.targets).toHaveLength(3);
    expect(r.activeIdxs).toEqual([0, 1]);
    expect(r.targets[2]).toBe(0);
  });
});

describe('DEFAULT_POOL_QUOTAS', () => {
  it('ships a 50/50 Knight default with Knight3 disabled', () => {
    expect(DEFAULT_POOL_QUOTAS[NewOrderRankType.Knight]).toEqual([0.5, 0.5, 0]);
  });

  it('does not ship defaults for Acolyte or Templar (legacy sequential preserved)', () => {
    expect(DEFAULT_POOL_QUOTAS[NewOrderRankType.Acolyte]).toBeUndefined();
    expect(DEFAULT_POOL_QUOTAS[NewOrderRankType.Templar]).toBeUndefined();
  });
});
