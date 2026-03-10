import { describe, it, expect } from 'vitest';
import { computeDynamicPool } from '../challenge-pool';

describe('computeDynamicPool', () => {
  const defaultDistribution = [50, 30, 20];

  it('returns base pool when there are zero entries', () => {
    const result = computeDynamicPool({
      basePrizePool: 2500,
      buzzPerAction: 5,
      actionCount: 0,
      maxPrizePool: null,
      prizeDistribution: defaultDistribution,
    });

    expect(result.totalPool).toBe(2500);
    expect(result.prizes).toEqual([
      { buzz: 1250, points: 150 },
      { buzz: 750, points: 100 },
      { buzz: 500, points: 50 },
    ]);
  });

  it('grows pool by buzzPerAction * actionCount', () => {
    const result = computeDynamicPool({
      basePrizePool: 2500,
      buzzPerAction: 5,
      actionCount: 100,
      maxPrizePool: null,
      prizeDistribution: defaultDistribution,
    });

    // 2500 + 5*100 = 3000
    expect(result.totalPool).toBe(3000);
    expect(result.prizes[0].buzz).toBe(1500); // 50% of 3000
    expect(result.prizes[1].buzz).toBe(900); // 30% of 3000
    expect(result.prizes[2].buzz).toBe(600); // 20% of 3000
  });

  it('clamps pool at maxPrizePool', () => {
    const result = computeDynamicPool({
      basePrizePool: 2500,
      buzzPerAction: 5,
      actionCount: 10000,
      maxPrizePool: 10000,
      prizeDistribution: defaultDistribution,
    });

    // 2500 + 5*10000 = 52500, capped at 10000
    expect(result.totalPool).toBe(10000);
    expect(result.prizes[0].buzz).toBe(5000);
    expect(result.prizes[1].buzz).toBe(3000);
    expect(result.prizes[2].buzz).toBe(2000);
  });

  it('does not clamp when pool is below max', () => {
    const result = computeDynamicPool({
      basePrizePool: 2500,
      buzzPerAction: 5,
      actionCount: 10,
      maxPrizePool: 10000,
      prizeDistribution: defaultDistribution,
    });

    // 2500 + 5*10 = 2550, below 10000
    expect(result.totalPool).toBe(2550);
  });

  it('does not clamp when pool exactly equals max', () => {
    const result = computeDynamicPool({
      basePrizePool: 0,
      buzzPerAction: 100,
      actionCount: 100,
      maxPrizePool: 10000,
      prizeDistribution: defaultDistribution,
    });

    expect(result.totalPool).toBe(10000);
  });

  it('assigns rounding remainder to 1st place', () => {
    // 100 with 33/33/34 distribution:
    // floor(100*33/100) = 33, floor(100*33/100) = 33, floor(100*34/100) = 34 → allocated = 100
    // But try a case that actually rounds: 1000 with 33/33/34
    // floor(10000*33/100) = 3300, floor(10000*33/100) = 3300, floor(10000*34/100) = 3400 → 10000, no remainder

    // Use a pool that causes rounding: 10 with 33/33/34
    // floor(10*33/100) = 3, floor(10*33/100) = 3, floor(10*34/100) = 3 → allocated = 9, remainder = 1
    const result = computeDynamicPool({
      basePrizePool: 10,
      buzzPerAction: 0,
      actionCount: 0,
      maxPrizePool: null,
      prizeDistribution: [33, 33, 34],
    });

    expect(result.totalPool).toBe(10);
    expect(result.prizes[0].buzz).toBe(4); // 3 + 1 remainder
    expect(result.prizes[1].buzz).toBe(3);
    expect(result.prizes[2].buzz).toBe(3);
    // Verify total allocated equals pool
    expect(result.prizes.reduce((sum, p) => sum + p.buzz, 0)).toBe(10);
  });

  it('handles zero base pool with growth', () => {
    const result = computeDynamicPool({
      basePrizePool: 0,
      buzzPerAction: 10,
      actionCount: 50,
      maxPrizePool: null,
      prizeDistribution: defaultDistribution,
    });

    expect(result.totalPool).toBe(500);
    expect(result.prizes[0].buzz).toBe(250);
    expect(result.prizes[1].buzz).toBe(150);
    expect(result.prizes[2].buzz).toBe(100);
  });

  it('handles zero buzzPerAction (base only, no growth)', () => {
    const result = computeDynamicPool({
      basePrizePool: 5000,
      buzzPerAction: 0,
      actionCount: 9999,
      maxPrizePool: null,
      prizeDistribution: defaultDistribution,
    });

    expect(result.totalPool).toBe(5000);
  });

  it('assigns default points by place', () => {
    const result = computeDynamicPool({
      basePrizePool: 1000,
      buzzPerAction: 0,
      actionCount: 0,
      maxPrizePool: null,
      prizeDistribution: defaultDistribution,
    });

    expect(result.prizes[0].points).toBe(150);
    expect(result.prizes[1].points).toBe(100);
    expect(result.prizes[2].points).toBe(50);
  });

  it('total allocated buzz always equals totalPool', () => {
    // Test with several awkward distributions that cause rounding
    const cases = [
      { pool: 7, dist: [33, 33, 34] },
      { pool: 1, dist: [50, 30, 20] },
      { pool: 13, dist: [40, 35, 25] },
      { pool: 9999, dist: [33, 33, 34] },
      { pool: 0, dist: [50, 30, 20] },
    ];

    for (const { pool, dist } of cases) {
      const result = computeDynamicPool({
        basePrizePool: pool,
        buzzPerAction: 0,
        actionCount: 0,
        maxPrizePool: null,
        prizeDistribution: dist,
      });

      const totalAllocated = result.prizes.reduce((sum, p) => sum + p.buzz, 0);
      expect(totalAllocated).toBe(result.totalPool);
    }
  });
});
