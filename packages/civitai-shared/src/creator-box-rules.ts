/**
 * Creator mystery packs: the rules a box a creator builds from their own cosmetics must meet. The
 * composer preview, the submit and approve checks and the review pane all call these, so what a
 * creator is shown is what review enforces. Pure: callers load the rows and pass plain values.
 *
 * A creator doesn't type weights. They put each item in a tier and pick a steepness `r`, and each
 * tier's weight is proportional to `items in tier × r^tier` (Common is tier 0). Every item in a tier
 * is then `r` times as likely as one in the tier below it.
 */
import { CosmeticShopItemStatus, CosmeticType } from '@civitai/db-schema/enums';
import { cosmeticEventOf, cosmeticTeamOf } from './mystery-box';

export const CREATOR_BOX_MIN_CONTENTS = 6;
export const CREATOR_BOX_MAX_CONTENTS = 50;
export const CREATOR_BOX_MIN_TIERS = 2;
export const CREATOR_BOX_MAX_TIERS = 4;
/** A creator box's tier weights always sum to this. */
export const CREATOR_BOX_WEIGHT_TOTAL = 10_000;
/** The price may be at most this many times the value of the least valuable item. */
export const CREATOR_BOX_WORST_DRAW_MULTIPLE = 2;

/** `r` as an exact fraction, so the tier order is checked without rounding. */
export const CREATOR_BOX_STEEPNESS = {
  gentle: { num: 3, den: 5 },
  standard: { num: 2, den: 5 },
  steep: { num: 1, den: 5 },
} as const;
export type CreatorBoxSteepness = keyof typeof CREATOR_BOX_STEEPNESS;

export type CreatorBoxTierName = { key: string; name: string };
/**
 * Tier keys and names by tier count, commonest first. Fixed, so no creator can call a 60% tier
 * "Legendary".
 */
export const CREATOR_BOX_TIERS: Record<number, readonly CreatorBoxTierName[]> = {
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
};

export type CreatorBoxCandidate = {
  cosmeticId: number;
  type: CosmeticType;
  createdById: number | null;
  /** `Cosmetic.data`. */
  data: unknown;
  /** The creator's own listing of it, if any. */
  listing: {
    addedById: number | null;
    status: CosmeticShopItemStatus;
    archivedAt: Date | null;
    availableQuantity: number | null;
    availableFrom: Date | null;
    availableTo: Date | null;
  } | null;
};

/**
 * Why this cosmetic can't go in this creator's box, or null if it can. Delisted is allowed: that is
 * a box-only item, and `creatorBoxContentValue` counts it at the floor.
 */
export function creatorBoxContentProblem(
  candidate: CreatorBoxCandidate,
  {
    creatorId,
    types,
    stickersEnabled,
    now,
  }: { creatorId: number; types: readonly CosmeticType[]; stickersEnabled: boolean; now: Date }
): string | null {
  if (candidate.createdById !== creatorId) return 'Only items you made can go in your mystery pack';
  const { listing } = candidate;
  if (
    !listing ||
    listing.addedById !== creatorId ||
    listing.status !== CosmeticShopItemStatus.Published ||
    listing.archivedAt
  )
    return 'Only items approved and live in your shop can go in a mystery pack';
  if (
    !types.includes(candidate.type) ||
    (candidate.type === CosmeticType.Sticker && !stickersEnabled)
  )
    return "This kind of item can't go in a mystery pack";
  // Event items are gated per buyer; a team item is drawn only by its team, so it would count
  // toward the price bounds for buyers who can never get it.
  if (cosmeticEventOf(candidate.data) !== undefined)
    return "Event items can't go in a mystery pack";
  if (cosmeticTeamOf(candidate.data) !== undefined) return "Team items can't go in a mystery pack";
  // A box draw doesn't count against a listing's stock or sale window, so a capped or scheduled
  // item would sell past its cap, before its drop or after it ended.
  if (listing.availableQuantity !== null || listing.availableTo !== null)
    return "Items with limited stock or an end date can't go in a mystery pack";
  if (listing.availableFrom !== null && listing.availableFrom > now)
    return "Items that aren't on sale yet can't go in a mystery pack";
  return null;
}

/**
 * What an item counts for in the price bounds: its shelf price if it's on the shelf, otherwise the
 * floor. A box-only item has no price a buyer could pay, so its creator doesn't get to name one.
 */
export const creatorBoxContentValue = (
  listing: { listed: boolean; unitAmount: number },
  floor: number
) => (listing.listed ? listing.unitAmount : floor);

export type CreatorBoxWeights = { ok: true; weights: number[] } | { ok: false; reason: string };

/** Integer tier weights for these tier sizes (commonest first), or why the layout is refused. */
export function creatorBoxWeights(
  tierSizes: readonly number[],
  steepness: CreatorBoxSteepness
): CreatorBoxWeights {
  const tiers = CREATOR_BOX_TIERS[tierSizes.length];
  if (!tiers)
    return {
      ok: false,
      reason: `A mystery pack has ${CREATOR_BOX_MIN_TIERS} to ${CREATOR_BOX_MAX_TIERS} tiers`,
    };
  if (tierSizes.some((n) => !Number.isSafeInteger(n) || n < 1))
    return { ok: false, reason: 'Every tier needs at least one item' };
  const total = tierSizes.reduce((sum, n) => sum + n, 0);
  if (total < CREATOR_BOX_MIN_CONTENTS || total > CREATOR_BOX_MAX_CONTENTS)
    return {
      ok: false,
      reason: `A mystery pack holds ${CREATOR_BOX_MIN_CONTENTS} to ${CREATOR_BOX_MAX_CONTENTS} items`,
    };

  // n × r^t scaled by den^(k-1), so every share is an integer and the order check is exact.
  const { num, den } = CREATOR_BOX_STEEPNESS[steepness];
  const last = tierSizes.length - 1;
  const shares = tierSizes.map((n, t) => n * num ** t * den ** (last - t));
  // Checked before rounding, never after: rounding breaks an exact tie one way or the other, and
  // over every layout and preset it would pass thousands of tied layouts this refuses.
  for (let t = 0; t < last; t++)
    if (shares[t] <= shares[t + 1])
      return {
        ok: false,
        reason: `Put more items in ${tiers[t].name}, or fewer in ${tiers[t + 1].name}`,
      };

  // Largest remainder: floor every share, then give the leftover units to the biggest remainders.
  const sum = shares.reduce((a, b) => a + b, 0);
  const weights = shares.map((share) => Math.floor((share * CREATOR_BOX_WEIGHT_TOTAL) / sum));
  const leftover = CREATOR_BOX_WEIGHT_TOTAL - weights.reduce((a, b) => a + b, 0);
  const byRemainder = shares
    .map((share, t) => ({ t, remainder: (share * CREATOR_BOX_WEIGHT_TOTAL) % sum }))
    .sort((a, b) => b.remainder - a.remainder || a.t - b.t);
  for (let i = 0; i < leftover; i++) weights[byRemainder[i].t]++;

  // What is stored and shown is the integers, so they are what must hold the rules. Every layout
  // and preset passes (the exhaustive test); a failure here is a rounding bug, not the creator's.
  const problem = creatorBoxWeightsProblem(tierSizes, weights);
  if (problem) throw new RangeError(`Rounded weights ${weights.join('/')}: ${problem}`);
  return { ok: true, weights };
}

/**
 * Why these integer weights break the creator box rules, or null: they sum to the total, each is at
 * least 1, and both each tier's odds and each item's odds fall strictly from Common up.
 */
export function creatorBoxWeightsProblem(
  tierSizes: readonly number[],
  weights: readonly number[]
): string | null {
  if (weights.length !== tierSizes.length) return 'One weight per tier';
  if (weights.some((w) => !Number.isSafeInteger(w) || w < 1))
    return 'Weights are positive integers';
  if (weights.reduce((a, b) => a + b, 0) !== CREATOR_BOX_WEIGHT_TOTAL)
    return `Weights sum to ${CREATOR_BOX_WEIGHT_TOTAL}`;
  for (let t = 0; t + 1 < weights.length; t++) {
    if (weights[t] <= weights[t + 1]) return 'Each tier is less likely than the one before';
    // w[t] / n[t] > w[t+1] / n[t+1], cross-multiplied to stay in integers.
    if (weights[t] * tierSizes[t + 1] <= weights[t + 1] * tierSizes[t])
      return 'Each item is less likely than one in the tier before';
  }
  return null;
}

export type CreatorBoxTierValues = { weight: number; values: readonly number[] };
export type CreatorBoxPriceBounds = {
  min: number;
  max: number;
  /** What the average box gives back at base odds, rounded down. */
  average: number;
  /** The least valuable item: the worst draw. */
  worst: number;
};

/**
 * The prices a box may sell for: at least the floor, at most the average value back, and at most
 * `CREATOR_BOX_WORST_DRAW_MULTIPLE` times the worst draw. `max < min` means no price is allowed.
 */
export function creatorBoxPriceBounds(
  tiers: readonly CreatorBoxTierValues[],
  floor: number
): CreatorBoxPriceBounds {
  for (const tier of tiers) {
    if (!Number.isSafeInteger(tier.weight) || tier.weight < 1)
      throw new RangeError(`Tier weight ${tier.weight} is not a positive integer`);
    if (!tier.values.length) throw new RangeError('Every tier needs at least one item');
    if (tier.values.some((v) => !Number.isSafeInteger(v) || v < 1))
      throw new RangeError('Item values are positive integers');
  }
  if (!tiers.length) throw new RangeError('A box needs at least one tier');
  // The floor is the only lower bound on the price, so a missing or zero floor would allow a free box.
  if (!Number.isSafeInteger(floor) || floor < 1)
    throw new RangeError(`Price floor ${floor} is not a positive integer`);

  // average = Σ weight × mean(values) / Σ weight, exactly: over the common denominator
  // Π(tier sizes) × Σ weight, in BigInt because values are creator-set and unbounded.
  const zero = BigInt(0);
  const sizes = tiers.map((tier) => BigInt(tier.values.length));
  const product = sizes.reduce((a, b) => a * b, BigInt(1));
  const numerator = tiers.reduce(
    (acc, tier, i) =>
      acc +
      BigInt(tier.weight) *
        tier.values.reduce((sum, v) => sum + BigInt(v), zero) *
        (product / sizes[i]),
    zero
  );
  const totalWeight = tiers.reduce((sum, tier) => sum + BigInt(tier.weight), zero);
  const average = Number(numerator / (product * totalWeight));
  const worst = Math.min(...tiers.flatMap((tier) => tier.values));
  return {
    min: floor,
    max: Math.min(average, CREATOR_BOX_WORST_DRAW_MULTIPLE * worst),
    average,
    worst,
  };
}

/** Why a box can't sell at this price, or null if it can. */
export function creatorBoxPriceProblem(price: number, bounds: CreatorBoxPriceBounds) {
  if (!Number.isSafeInteger(price)) return 'The price is a whole amount of Buzz';
  if (bounds.max < bounds.min)
    return 'No price works for this mystery pack: add more valuable items or drop the cheapest';
  if (price < bounds.min) return `The price is at least ${bounds.min}`;
  if (price > bounds.average)
    return `The price is at most ${bounds.average}, what the average box gives back`;
  if (price > CREATOR_BOX_WORST_DRAW_MULTIPLE * bounds.worst)
    return `The price is at most ${
      CREATOR_BOX_WORST_DRAW_MULTIPLE * bounds.worst
    }, ${CREATOR_BOX_WORST_DRAW_MULTIPLE} times the least valuable item`;
  return null;
}
