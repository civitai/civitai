import { describe, expect, it, vi } from 'vitest';
import {
  computeBoxOdds,
  drawFromOdds,
  drawWithRolls,
  MAX_BOX_WEIGHT,
  type BoxOdds,
  type BoxOddsEntryInput,
  type BoxOddsTierInput,
} from '../box-odds';

// The birthday box's shape: four tiers with weights 50/27/17/6 holding 35/32/30/23 rewards. Tier ids
// run against sortOrder on purpose, so a walk ordered by id instead of sortOrder reads differently.
const TIERS: BoxOddsTierInput[] = [
  { id: 4, weight: 50, sortOrder: 0 },
  { id: 3, weight: 27, sortOrder: 1 },
  { id: 2, weight: 17, sortOrder: 2 },
  { id: 1, weight: 6, sortOrder: 3 },
];
const SIZES: Record<number, number> = { 4: 35, 3: 32, 2: 30, 1: 23 };

// Content ids are tierId * 1000 + n, listed out of order so the per-tier sort is exercised.
const fullPool = (): BoxOddsEntryInput[] =>
  TIERS.flatMap(({ id }) =>
    Array.from({ length: SIZES[id] }, (_, n) => ({ contentId: id * 1000 + n, tierId: id }))
  ).reverse();

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const lcm = (values: number[]) => values.reduce((a, b) => (a * b) / gcd(a, b), 1);

/**
 * Every (tierRoll, itemRoll) pair the draw can make, each weighted by its true chance
 * 1 / (eligibleWeight * tierPoolSize). Chances are kept as integer units over a common denominator
 * so the comparison is exact: no sampling, so nothing can flake.
 */
function enumerate(odds: BoxOdds) {
  const unitsPerTierRoll = lcm(odds.tiers.map((t) => t.contentIds.length));
  const denominator = odds.eligibleWeight * unitsPerTierRoll;
  const units = new Map<number, number>();
  for (let tierRoll = 0; tierRoll < odds.eligibleWeight; tierRoll++) {
    const poolSize = drawWithRolls(odds, { tierRoll, itemRoll: 0 }).tierPoolSize;
    for (let itemRoll = 0; itemRoll < poolSize; itemRoll++) {
      const { contentId } = drawWithRolls(odds, { tierRoll, itemRoll });
      units.set(contentId, (units.get(contentId) ?? 0) + unitsPerTierRoll / poolSize);
    }
  }
  return { units, denominator, unitsPerTierRoll };
}

/**
 * Each reward the draw can reach comes up exactly as often as its tier's weight over the eligible
 * weight, split evenly in the tier, and the odds a user is shown say the same.
 */
function expectDrawMatchesShownOdds(odds: BoxOdds, pool: BoxOddsEntryInput[]) {
  const { units, denominator, unitsPerTierRoll } = enumerate(odds);

  // Every reward left is reachable, and nothing else is.
  expect([...units.keys()].sort((a, b) => a - b)).toEqual(
    pool.map((e) => e.contentId).sort((a, b) => a - b)
  );

  const tierById = new Map(TIERS.map((t) => [t.id, t]));
  const eligibleWeight = new Set(pool.map((e) => e.tierId));
  const expectedEligible = [...eligibleWeight].reduce((s, id) => s + tierById.get(id)!.weight, 0);
  expect(odds.eligibleWeight).toBe(expectedEligible);

  for (const entry of pool) {
    const weight = tierById.get(entry.tierId)!.weight;
    const left = pool.filter((e) => e.tierId === entry.tierId).length;
    // Exact: weight / (eligible * left), in units of 1 / denominator.
    expect(units.get(entry.contentId)).toBe((weight * unitsPerTierRoll) / left);

    // What the user is shown is the same number the draw produced.
    const shown = odds.tiers.find((t) => t.tierId === entry.tierId)!;
    expect(shown.itemProbability).toBeCloseTo(units.get(entry.contentId)! / denominator, 12);
    expect(shown.probability).toBeCloseTo((units.get(entry.contentId)! * left) / denominator, 12);
  }

  const total = odds.tiers.reduce((s, t) => s + t.probability, 0);
  expect(total).toBeCloseTo(1, 12);
}

describe('box odds: every roll enumerated', () => {
  it('a full box', () => {
    const pool = fullPool();
    const odds = computeBoxOdds(TIERS, pool);
    expect(odds.tiers.map((t) => [t.tierId, t.probability])).toEqual([
      [4, 0.5],
      [3, 0.27],
      [2, 0.17],
      [1, 0.06],
    ]);
    expectDrawMatchesShownOdds(odds, pool);
  });

  it('a tier the user owns all of drops out and the rest renormalise by their own weights', () => {
    const pool = fullPool().filter((e) => e.tierId !== 4);
    const odds = computeBoxOdds(TIERS, pool);
    expect(odds.eligibleWeight).toBe(50);
    expect(odds.tiers.map((t) => t.tierId)).toEqual([3, 2, 1]);
    // Removing half the weight doubles the rarest tier's chance.
    expect(odds.tiers.find((t) => t.tierId === 1)?.probability).toBe(0.12);
    expectDrawMatchesShownOdds(odds, pool);
  });

  it('one reward left', () => {
    const pool = [{ contentId: 2007, tierId: 2 }];
    const odds = computeBoxOdds(TIERS, pool);
    expect(odds).toEqual({
      eligibleWeight: 17,
      tiers: [{ tierId: 2, weight: 17, contentIds: [2007], probability: 1, itemProbability: 1 }],
    });
    expectDrawMatchesShownOdds(odds, pool);
  });

  it("a team-filtered pool: only some of each tier's rewards", () => {
    const pool = fullPool().filter((e) => e.contentId % 4 === 1);
    const odds = computeBoxOdds(TIERS, pool);
    expect(odds.tiers.map((t) => t.contentIds.length)).toEqual([9, 8, 8, 6]);
    expectDrawMatchesShownOdds(odds, pool);
  });

  it('an empty pool has nothing to draw', () => {
    const odds = computeBoxOdds(TIERS, []);
    expect(odds).toEqual({ eligibleWeight: 0, tiers: [] });
    const randomInt = vi.fn(() => 0);
    expect(() => drawFromOdds(odds, randomInt)).toThrow('Nothing left');
    expect(randomInt).not.toHaveBeenCalled();
  });
});

describe('box odds: rolls replay', () => {
  // Recorded rolls are the audit trail: they must keep picking the same reward. These pin the walk
  // order (sortOrder, then id) and the in-tier order (content id ascending).
  const odds = computeBoxOdds(TIERS, fullPool());

  it.each([
    [0, 0, 4, 4000],
    [49, 34, 4, 4034],
    [50, 0, 3, 3000],
    [76, 31, 3, 3031],
    [77, 5, 2, 2005],
    [93, 29, 2, 2029],
    [94, 0, 1, 1000],
    [99, 22, 1, 1022],
  ])('tierRoll %i, itemRoll %i -> tier %i, content %i', (tierRoll, itemRoll, tierId, contentId) => {
    expect(drawWithRolls(odds, { tierRoll, itemRoll })).toMatchObject({ tierId, contentId });
  });

  it('a sortOrder tie walks by tier id', () => {
    const tied = computeBoxOdds(
      [
        { id: 8, weight: 1, sortOrder: 0 },
        { id: 7, weight: 1, sortOrder: 0 },
      ],
      [
        { contentId: 80, tierId: 8 },
        { contentId: 70, tierId: 7 },
      ]
    );
    expect(drawWithRolls(tied, { tierRoll: 0, itemRoll: 0 }).contentId).toBe(70);
  });

  it('orders a tier by content id as numbers, not as text', () => {
    const mixed = computeBoxOdds(
      [{ id: 1, weight: 1, sortOrder: 0 }],
      [100, 9, 10].map((contentId) => ({ contentId, tierId: 1 }))
    );
    expect(mixed.tiers[0].contentIds).toEqual([9, 10, 100]);
    expect(drawWithRolls(mixed, { tierRoll: 0, itemRoll: 0 }).contentId).toBe(9);
  });

  it('records every audit field', () => {
    expect(drawWithRolls(odds, { tierRoll: 80, itemRoll: 3 })).toEqual({
      tierId: 2,
      contentId: 2003,
      tierWeight: 17,
      eligibleWeight: 100,
      tierRoll: 80,
      tierPoolSize: 30,
      itemRoll: 3,
    });
  });
});

describe('drawFromOdds', () => {
  const odds = computeBoxOdds(TIERS, fullPool());

  it('rolls the tier below the eligible weight, then the reward below the tier size', () => {
    const randomInt = vi.fn().mockReturnValueOnce(95).mockReturnValueOnce(4);
    expect(drawFromOdds(odds, randomInt)).toMatchObject({ tierId: 1, contentId: 1004 });
    expect(randomInt.mock.calls).toEqual([[100], [23]]);
  });

  it.each([
    ['a tier roll at the bound', [100, 0]],
    ['a negative roll', [-1, 0]],
    ['a fractional roll', [0.5, 0]],
    ['an item roll at the tier size', [0, 35]],
  ])('throws on %s rather than skewing the odds', (_, rolls) => {
    const randomInt = vi.fn().mockReturnValueOnce(rolls[0]).mockReturnValueOnce(rolls[1]);
    expect(() => drawFromOdds(odds, randomInt)).toThrow(/Roll -?[\d.]+ is outside \[0, \d+\)/);
  });
});

describe('computeBoxOdds refuses a box it cannot draw honestly', () => {
  it.each([0, -3, 1.5, Number.NaN, 2 ** 53])('a tier weight of %s', (weight) => {
    expect(() =>
      computeBoxOdds([{ id: 1, weight, sortOrder: 0 }], [{ contentId: 1, tierId: 1 }])
    ).toThrow('weights are positive integers');
  });

  it('weights summing past what the opening record can hold, even with that tier exhausted', () => {
    const tiers = [
      { id: 1, weight: MAX_BOX_WEIGHT - 1, sortOrder: 0 },
      { id: 2, weight: 2, sortOrder: 1 },
    ];
    expect(() => computeBoxOdds(tiers, [{ contentId: 1, tierId: 2 }])).toThrow('the most is');
    // The bound itself is allowed.
    expect(
      computeBoxOdds(
        [{ id: 1, weight: MAX_BOX_WEIGHT, sortOrder: 0 }],
        [{ contentId: 1, tierId: 1 }]
      ).eligibleWeight
    ).toBe(MAX_BOX_WEIGHT);
  });

  it('a reward in a tier the box does not have', () => {
    expect(() => computeBoxOdds(TIERS, [{ contentId: 1, tierId: 99 }])).toThrow('unknown tier');
  });
});
