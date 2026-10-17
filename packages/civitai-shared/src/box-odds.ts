/**
 * Mystery box odds: the only code that turns a box's tier weights and what is left in it for one
 * user into probabilities, and the only code that draws from them. The odds sheet, the purchase
 * check and the open all go through here, so what a buyer is shown is what the draw ran under.
 *
 * A tier's probability is its weight over the summed weights of the tiers with anything left for
 * the user; within a tier every reward is equally likely. A tier with nothing left drops out and the
 * rest renormalise, so odds shift toward the rarer tiers as a user collects.
 */

export type BoxOddsTierInput = { id: number; weight: number; sortOrder: number };
export type BoxOddsEntryInput = { contentId: number; tierId: number };

export type BoxTierOdds = {
  tierId: number;
  weight: number;
  /** What is left for the user in this tier, ascending. `itemRoll` indexes it. */
  contentIds: number[];
  /** weight / eligibleWeight */
  probability: number;
  /** The chance of each one reward in this tier: probability / contentIds.length. */
  itemProbability: number;
};

export type BoxOdds = {
  /** Summed weight of the tiers with anything left; `tierRoll` is drawn below it. */
  eligibleWeight: number;
  /** Tiers with anything left, in draw order: sortOrder, then id. */
  tiers: BoxTierOdds[];
};

export type BoxDraw = {
  tierId: number;
  contentId: number;
  tierWeight: number;
  eligibleWeight: number;
  tierRoll: number;
  tierPoolSize: number;
  itemRoll: number;
};

/** The most a box's tier weights may sum to: Postgres int4. */
export const MAX_BOX_WEIGHT = 2_147_483_647;

/** Uniform integer in [0, max). Server code passes `crypto.randomInt`. */
export type RandomInt = (max: number) => number;

export function computeBoxOdds(
  tiers: readonly BoxOddsTierInput[],
  pool: readonly BoxOddsEntryInput[]
): BoxOdds {
  const left = new Map<number, number[]>();
  let totalWeight = 0;
  for (const tier of tiers) {
    if (!Number.isSafeInteger(tier.weight) || tier.weight <= 0)
      throw new RangeError(
        `Box tier ${tier.id} has weight ${tier.weight}; weights are positive integers`
      );
    totalWeight += tier.weight;
    left.set(tier.id, []);
  }
  // The draw records its weights in int4 columns, so a box above that could never be opened.
  if (totalWeight > MAX_BOX_WEIGHT)
    throw new RangeError(`Box weights sum to ${totalWeight}; the most is ${MAX_BOX_WEIGHT}`);
  for (const entry of pool) {
    const contentIds = left.get(entry.tierId);
    // A reward in a tier this box doesn't have would be drawn at odds nobody was shown.
    if (!contentIds)
      throw new RangeError(`Box content ${entry.contentId} is in unknown tier ${entry.tierId}`);
    contentIds.push(entry.contentId);
  }

  const eligible = [...tiers]
    .filter((tier) => left.get(tier.id)!.length > 0)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  const eligibleWeight = eligible.reduce((sum, tier) => sum + tier.weight, 0);

  return {
    eligibleWeight,
    tiers: eligible.map((tier) => {
      const contentIds = left.get(tier.id)!.sort((a, b) => a - b);
      const probability = tier.weight / eligibleWeight;
      return {
        tierId: tier.id,
        weight: tier.weight,
        contentIds,
        probability,
        itemProbability: probability / contentIds.length,
      };
    }),
  };
}

function assertRoll(name: string, roll: number, max: number) {
  if (!Number.isInteger(roll) || roll < 0 || roll >= max)
    throw new RangeError(`${name} ${roll} is outside [0, ${max})`);
}

function tierForRoll(odds: BoxOdds, tierRoll: number) {
  assertRoll('tierRoll', tierRoll, odds.eligibleWeight);
  let below = 0;
  for (const tier of odds.tiers) {
    below += tier.weight;
    if (tierRoll < below) return tier;
  }
  // Unreachable: the rolls are bounded by eligibleWeight, the sum of the weights walked.
  throw new RangeError(`tierRoll ${tierRoll} fell past every tier`);
}

/**
 * The reward a pair of rolls picks. Deterministic, so an opening's recorded rolls replay to the
 * same reward against the same odds.
 */
export function drawWithRolls(
  odds: BoxOdds,
  { tierRoll, itemRoll }: { tierRoll: number; itemRoll: number }
): BoxDraw {
  const tier = tierForRoll(odds, tierRoll);
  assertRoll('itemRoll', itemRoll, tier.contentIds.length);
  return {
    tierId: tier.tierId,
    contentId: tier.contentIds[itemRoll],
    tierWeight: tier.weight,
    eligibleWeight: odds.eligibleWeight,
    tierRoll,
    tierPoolSize: tier.contentIds.length,
    itemRoll,
  };
}

/** Draws one reward. Throws when nothing is left: the caller keeps the box. */
export function drawFromOdds(odds: BoxOdds, randomInt: RandomInt): BoxDraw {
  if (odds.eligibleWeight <= 0) throw new RangeError('Nothing left to draw from this box');
  const tierRoll = randomInt(odds.eligibleWeight);
  const itemRoll = randomInt(tierForRoll(odds, tierRoll).contentIds.length);
  return drawWithRolls(odds, { tierRoll, itemRoll });
}
