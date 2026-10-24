import { CosmeticShopItemStatus, CosmeticType } from '@civitai/db-schema/enums';
import { describe, expect, it } from 'vitest';
import {
  CREATOR_BOX_MAX_CONTENTS,
  CREATOR_BOX_MAX_TIERS,
  CREATOR_BOX_MIN_CONTENTS,
  CREATOR_BOX_MIN_TIERS,
  CREATOR_BOX_STEEPNESS,
  CREATOR_BOX_TIERS,
  CREATOR_BOX_WEIGHT_TOTAL,
  creatorBoxContentProblem,
  creatorBoxContentValue,
  creatorBoxPriceBounds,
  creatorBoxPriceProblem,
  creatorBoxWeights,
  creatorBoxWeightsProblem,
  type CreatorBoxCandidate,
  type CreatorBoxSteepness,
} from '../creator-box-rules';

const PRESETS = Object.keys(CREATOR_BOX_STEEPNESS) as CreatorBoxSteepness[];

/** Every way to split `total` items into `tiers` non-empty tiers, commonest first. */
function* layouts(total: number, tiers: number, prefix: number[] = []): Generator<number[]> {
  if (tiers === 1) {
    yield [...prefix, total];
    return;
  }
  for (let first = 1; first <= total - (tiers - 1); first++)
    yield* layouts(total - first, tiers - 1, [...prefix, first]);
}

const choose = (n: number, k: number) => {
  let result = 1;
  for (let i = 0; i < k; i++) result = (result * (n - i)) / (i + 1);
  return result;
};

/**
 * The rule as the design states it, in exact arithmetic and written independently of the module:
 * each tier's odds `n × r^t` fall strictly from Common up.
 */
function tiersFallExactly(sizes: number[], steepness: CreatorBoxSteepness) {
  const { num, den } = CREATOR_BOX_STEEPNESS[steepness];
  // n[t] r^t > n[t+1] r^(t+1)  <=>  n[t] × den > n[t+1] × num
  return sizes.every((n, t) => t === sizes.length - 1 || n * den > sizes[t + 1] * num);
}

/** What any accepted set of weights must hold, checked here rather than by the module's own check. */
function brokenRule(sizes: number[], weights: number[]) {
  if (weights.length !== sizes.length) return 'length';
  if (weights.reduce((a, b) => a + b, 0) !== CREATOR_BOX_WEIGHT_TOTAL) return 'sum';
  if (weights.some((w) => !Number.isInteger(w) || w < 1)) return 'not a positive integer';
  for (let t = 0; t + 1 < weights.length; t++) {
    if (!(weights[t] > weights[t + 1])) return `tier ${t + 1} not less likely`;
    if (!(weights[t] / sizes[t] > weights[t + 1] / sizes[t + 1]))
      return `items in tier ${t + 1} not less likely`;
  }
  return null;
}

describe('creatorBoxWeights over every layout and preset', () => {
  // The design left open whether rounding to integer weights keeps the rule for every layout. This
  // settles it: every layout of 6 to 50 items in 2 to 4 tiers, under every preset.
  it.each(PRESETS)(
    '%s: accepts exactly the layouts whose tiers fall, with integer weights that hold the rule',
    (steepness) => {
      let expectedLayouts = 0;
      for (let tiers = CREATOR_BOX_MIN_TIERS; tiers <= CREATOR_BOX_MAX_TIERS; tiers++)
        for (let total = CREATOR_BOX_MIN_CONTENTS; total <= CREATOR_BOX_MAX_CONTENTS; total++)
          expectedLayouts += choose(total - 1, tiers - 1);

      let seen = 0;
      let accepted = 0;
      const wrongVerdict: string[] = [];
      const broken: string[] = [];
      for (let tiers = CREATOR_BOX_MIN_TIERS; tiers <= CREATOR_BOX_MAX_TIERS; tiers++)
        for (let total = CREATOR_BOX_MIN_CONTENTS; total <= CREATOR_BOX_MAX_CONTENTS; total++)
          for (const sizes of layouts(total, tiers)) {
            seen++;
            const result = creatorBoxWeights(sizes, steepness);
            if (result.ok !== tiersFallExactly(sizes, steepness))
              wrongVerdict.push(`${sizes.join('/')} ok=${result.ok}`);
            if (!result.ok) continue;
            accepted++;
            const problem = brokenRule(sizes, result.weights);
            if (problem)
              broken.push(`${sizes.join('/')} -> ${result.weights.join('/')}: ${problem}`);
          }

      expect(seen).toBe(expectedLayouts);
      expect(wrongVerdict.slice(0, 5)).toEqual([]);
      expect(broken.slice(0, 5)).toEqual([]);
      // Both verdicts occur, so neither list above is empty for want of cases.
      expect(accepted).toBeGreaterThan(0);
      expect(accepted).toBeLessThan(seen);
    }
  );

  // One vector per preset pins the steepness fractions themselves, which the exhaustive test can't
  // see: its oracle reads the same fractions.
  it.each<[CreatorBoxSteepness, number[]]>([
    ['gentle', [7176, 2153, 516, 155]],
    ['standard', [8075, 1615, 258, 52]],
    ['steep', [9019, 902, 72, 7]],
  ])("the design's worked example, 10 / 5 / 2 / 1 items: %s", (steepness, weights) => {
    expect(creatorBoxWeights([10, 5, 2, 1], steepness)).toEqual({ ok: true, weights });
  });

  it('names tiers by count, commonest first', () => {
    expect(CREATOR_BOX_TIERS).toEqual({
      2: [
        { key: 'common', name: 'Common' },
        { key: 'rare', name: 'Rare' },
      ],
      3: [
        { key: 'common', name: 'Common' },
        { key: 'rare', name: 'Rare' },
        { key: 'legendary', name: 'Legendary' },
      ],
      4: [
        { key: 'common', name: 'Common' },
        { key: 'uncommon', name: 'Uncommon' },
        { key: 'rare', name: 'Rare' },
        { key: 'legendary', name: 'Legendary' },
      ],
    });
  });

  // Decision: the tier order is checked on the exact shares, before rounding. Rounding these exact
  // ties gives 7143 / 1429 / 1428, which a check on the rounded weights would pass, and the
  // exhaustive test above finds many more like it. Don't move the check after rounding.
  it('refuses an exact tie that rounding would break in its favour', () => {
    expect(creatorBoxWeights([4, 2, 5], 'standard')).toEqual({
      ok: false,
      reason: 'Put more items in Rare, or fewer in Legendary',
    });
  });

  it('names the tier that needs more items', () => {
    expect(creatorBoxWeights([2, 20], 'standard')).toEqual({
      ok: false,
      reason: 'Put more items in Common, or fewer in Rare',
    });
  });

  it.each([
    [[10], 'A mystery pack has 2 to 4 tiers'],
    [[2, 2, 2, 2, 2], 'A mystery pack has 2 to 4 tiers'],
    [[6, 0], 'Every tier needs at least one item'],
    [[5.5, 1], 'Every tier needs at least one item'],
    [[4, 1], 'A mystery pack holds 6 to 50 items'],
    [[50, 1], 'A mystery pack holds 6 to 50 items'],
  ])('refuses %j', (sizes, reason) => {
    expect(creatorBoxWeights(sizes, 'standard')).toEqual({ ok: false, reason });
  });
});

describe('creatorBoxWeightsProblem', () => {
  it('passes weights the module computed', () => {
    expect(creatorBoxWeightsProblem([10, 5, 2, 1], [8075, 1615, 258, 52])).toBeNull();
  });

  it.each([
    ['a wrong total', [5, 5], [6000, 3000], 'Weights sum to 10000'],
    ['a zero weight', [5, 5], [10000, 0], 'Weights are positive integers'],
    ['a fraction', [5, 5], [6000.5, 3999.5], 'Weights are positive integers'],
    ['one weight short', [5, 5, 5], [6000, 4000], 'One weight per tier'],
    ['tied tiers', [5, 5], [5000, 5000], 'Each tier is less likely than the one before'],
    // The tier falls (9000 > 1000) but its one item is likelier than each Common (1000 > 900).
    [
      'a likelier item',
      [10, 1],
      [9000, 1000],
      'Each item is less likely than one in the tier before',
    ],
    // The tier falls (7500 > 2500) but each item is exactly 2500 in both: a tie is not "less likely".
    [
      'equally likely items',
      [3, 1],
      [7500, 2500],
      'Each item is less likely than one in the tier before',
    ],
  ])('refuses %s', (_label, sizes, weights, problem) => {
    expect(creatorBoxWeightsProblem(sizes, weights)).toBe(problem);
  });
});

describe('creatorBoxPriceBounds', () => {
  const values = (n: number, value: number) => Array<number>(n).fill(value);

  it("the design's worked example: Standard, valued 500 / 1,000 / 3,000 / 10,000", () => {
    // Σ weight × value / total weight, rounded down.
    const bounds = creatorBoxPriceBounds(
      [
        { weight: 8075, values: values(10, 500) },
        { weight: 1615, values: values(5, 1000) },
        { weight: 258, values: values(2, 3000) },
        { weight: 52, values: values(1, 10000) },
      ],
      500
    );
    expect(bounds).toEqual({ min: 500, max: 694, average: 694, worst: 500 });
  });

  it('averages within a tier: a tier counts its mean value, not its total', () => {
    const bounds = creatorBoxPriceBounds(
      [
        { weight: 6000, values: [500, 1500] },
        { weight: 4000, values: [2000] },
      ],
      500
    );
    // 60% at a mean of 1000 plus 40% at 2000.
    expect(bounds.average).toBe(1400);
    expect(bounds.max).toBe(1000);
  });

  it('caps the price at twice the worst draw when one costly item lifts the average', () => {
    const bounds = creatorBoxPriceBounds(
      [
        { weight: 9000, values: values(5, 500) },
        { weight: 1000, values: [333_333] },
      ],
      500
    );
    expect(bounds.average).toBe(33_783);
    expect(bounds.max).toBe(1000);
  });

  it('allows a price exactly at the average, where floating point lands just under it', () => {
    // Exactly 507, but 0.7 × 504 + 0.3 × 514 is 506.99999999999994 in floating point, which would
    // refuse a price of 507.
    const bounds = creatorBoxPriceBounds(
      [
        { weight: 7000, values: [504] },
        { weight: 3000, values: [514] },
      ],
      500
    );
    expect(bounds.average).toBe(507);
    expect(creatorBoxPriceProblem(507, bounds)).toBeNull();
  });

  // Each bad tier sits beside a good one, so the throw comes from its own guard and not from a
  // zero total weight or an empty division.
  const good = { weight: 10000, values: [500] };
  it.each<[string, { weight: number; values: number[] }[], number, string]>([
    [
      'a zero weight',
      [{ weight: 0, values: [10] }, good],
      500,
      'Tier weight 0 is not a positive integer',
    ],
    [
      'a negative weight',
      [{ weight: -1, values: [10] }, good],
      500,
      'Tier weight -1 is not a positive integer',
    ],
    ['an empty tier', [{ weight: 1, values: [] }, good], 500, 'Every tier needs at least one item'],
    ['a zero value', [{ weight: 1, values: [0] }, good], 500, 'Item values are positive integers'],
    ['no tiers', [], 500, 'A box needs at least one tier'],
    // A floor read from config that came back unset would otherwise allow a free box.
    ['a missing floor', [good], NaN, 'Price floor NaN is not a positive integer'],
    ['a zero floor', [good], 0, 'Price floor 0 is not a positive integer'],
    ['a negative floor', [good], -50, 'Price floor -50 is not a positive integer'],
  ])('throws on %s', (_label, tiers, floor, message) => {
    expect(() => creatorBoxPriceBounds(tiers, floor)).toThrow(new RangeError(message));
  });
});

describe('creatorBoxPriceProblem', () => {
  const bounds = { min: 500, max: 694, average: 694, worst: 500 };

  it('allows the whole range, ends included', () => {
    expect(creatorBoxPriceProblem(500, bounds)).toBeNull();
    expect(creatorBoxPriceProblem(694, bounds)).toBeNull();
  });

  it.each([
    [499, 'The price is at least 500'],
    [695, 'The price is at most 694, what the average box gives back'],
    [600.5, 'The price is a whole amount of Buzz'],
  ])('refuses %d', (price, problem) => {
    expect(creatorBoxPriceProblem(price, bounds)).toBe(problem);
  });

  it('allows exactly twice the worst draw and refuses one more', () => {
    const capped = { min: 500, max: 1000, average: 1400, worst: 500 };
    expect(creatorBoxPriceProblem(1000, capped)).toBeNull();
    expect(creatorBoxPriceProblem(1001, capped)).toBe(
      'The price is at most 1000, 2 times the least valuable item'
    );
  });

  it('refuses every price when no price fits', () => {
    const none = { min: 500, max: 400, average: 400, worst: 200 };
    expect(creatorBoxPriceProblem(500, none)).toMatch(/^No price works/);
  });
});

describe('creatorBoxContentValue', () => {
  it('counts a shelf item at its price and a box-only item at the floor', () => {
    expect(creatorBoxContentValue({ listed: true, unitAmount: 50_000 }, 500)).toBe(50_000);
    expect(creatorBoxContentValue({ listed: false, unitAmount: 50_000 }, 500)).toBe(500);
  });
});

describe('creatorBoxContentProblem', () => {
  const now = new Date('2026-10-19T00:00:00Z');
  const rules = {
    creatorId: 7,
    types: [CosmeticType.Badge, CosmeticType.Sticker],
    stickersEnabled: true,
    now,
  };
  const qualifying: CreatorBoxCandidate = {
    cosmeticId: 1,
    type: CosmeticType.Badge,
    createdById: 7,
    data: { url: 'badge.png' },
    listing: {
      addedById: 7,
      status: CosmeticShopItemStatus.Published,
      archivedAt: null,
      availableQuantity: null,
      availableFrom: null,
      availableTo: null,
    },
  };
  const withListing = (listing: Partial<NonNullable<CreatorBoxCandidate['listing']>>) => ({
    ...qualifying,
    listing: { ...qualifying.listing!, ...listing },
  });
  const notLive = 'Only items approved and live in your shop can go in a mystery pack';
  const limited = "Items with limited stock or an end date can't go in a mystery pack";

  // Each refusal below changes one field of this candidate, so this is their control.
  it('accepts an own, live, uncapped item, including one whose sale started now or earlier', () => {
    expect(creatorBoxContentProblem(qualifying, rules)).toBeNull();
    expect(creatorBoxContentProblem(withListing({ availableFrom: now }), rules)).toBeNull();
    expect(
      creatorBoxContentProblem(withListing({ availableFrom: new Date('2026-10-01') }), rules)
    ).toBeNull();
  });

  it.each<[string, CreatorBoxCandidate, string]>([
    [
      "another creator's item",
      { ...qualifying, createdById: 8 },
      'Only items you made can go in your mystery pack',
    ],
    [
      'a platform item',
      { ...qualifying, createdById: null },
      'Only items you made can go in your mystery pack',
    ],
    ['an item with no listing', { ...qualifying, listing: null }, notLive],
    // A reseller's listing of the creator's own item is not the creator's listing.
    ["another creator's listing of it", withListing({ addedById: 8 }), notLive],
    [
      'an item pending review',
      withListing({ status: CosmeticShopItemStatus.PendingReview }),
      notLive,
    ],
    ['an archived listing', withListing({ archivedAt: new Date('2026-10-01') }), notLive],
    [
      'a type creators cannot sell',
      { ...qualifying, type: CosmeticType.NamePlate },
      "This kind of item can't go in a mystery pack",
    ],
    [
      'an event item',
      { ...qualifying, data: { event: 'birthday' } },
      "Event items can't go in a mystery pack",
    ],
    [
      'a team item',
      { ...qualifying, data: { team: 'red' } },
      "Team items can't go in a mystery pack",
    ],
    ['a capped listing', withListing({ availableQuantity: 100 }), limited],
    ['a listing capped at zero', withListing({ availableQuantity: 0 }), limited],
    ['a listing with an end date', withListing({ availableTo: new Date('2026-12-01') }), limited],
    [
      'a listing not on sale yet',
      withListing({ availableFrom: new Date('2026-11-01') }),
      "Items that aren't on sale yet can't go in a mystery pack",
    ],
  ])('refuses %s', (_label, candidate, problem) => {
    expect(creatorBoxContentProblem(candidate, rules)).toBe(problem);
  });

  it('refuses a sticker only while stickers are off', () => {
    const sticker = { ...qualifying, type: CosmeticType.Sticker };
    expect(creatorBoxContentProblem(sticker, rules)).toBeNull();
    expect(creatorBoxContentProblem(sticker, { ...rules, stickersEnabled: false })).toBe(
      "This kind of item can't go in a mystery pack"
    );
  });
});
