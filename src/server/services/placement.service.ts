import { z } from 'zod';
import { dbRead } from '~/server/db/client';
import { getHighestTierSubscription } from '~/server/services/subscriptions.service';
import type { MembershipTier } from '~/shared/utils/subscription-tokens';
import type { PlacementPriceTier, PlacementSurface } from '~/shared/utils/placement';
import {
  clampDeclineFeeRate,
  PLACEMENT_MIN_PRICE,
  PLACEMENT_PRICE_CAP_TIERS,
  PLACEMENT_SURFACES,
  placementPriceCap,
} from '~/shared/utils/placement';

export const PLACEMENT_CONFIG_KEY = 'placement:config';

const priceCapTierSchema = z.object({
  minScore: z.number().min(0),
  caps: z.object({
    free: z.number().min(0),
    bronze: z.number().min(0),
    silver: z.number().min(0),
    gold: z.number().min(0),
  }),
});

const placementConfigSchema = z.object({
  declineFeeRates: z.record(z.string(), z.number()).optional(),
  expiryHours: z.record(z.string(), z.number().positive()).optional(),
  priceCapTiers: z.array(priceCapTierSchema).min(1).optional(),
  /** Per-surface override, so stickers and galleries can be priced apart later. */
  priceCapTiersBySurface: z.record(z.string(), z.array(priceCapTierSchema).min(1)).optional(),
});

export type PlacementConfig = {
  declineFeeRate: (surface: PlacementSurface) => number;
  expiryHours: (surface: PlacementSurface) => number;
  priceCapTiers: (surface: PlacementSurface) => PlacementPriceTier[];
};

/**
 * Operator-tunable values, in `KeyValue` alongside the other things we change
 * without a deploy. One accessor rather than a read at each refund site, so the
 * decline fee cannot differ between charging it and refunding around it.
 *
 * A malformed or missing row falls back to the compiled defaults instead of
 * throwing: placements failing closed on a bad config edit would take out the
 * whole feature, and every value it supplies is clamped anyway.
 */
export async function getPlacementConfig(): Promise<PlacementConfig> {
  let stored: z.infer<typeof placementConfigSchema> = {};

  try {
    const row = await dbRead.keyValue.findUnique({ where: { key: PLACEMENT_CONFIG_KEY } });
    const parsed = placementConfigSchema.safeParse(row?.value ?? {});
    if (parsed.success) stored = parsed.data;
  } catch {
    // Fall through to defaults.
  }

  return {
    declineFeeRate: (surface) =>
      clampDeclineFeeRate(
        stored.declineFeeRates?.[surface],
        PLACEMENT_SURFACES[surface].defaultDeclineFeeRate
      ),
    expiryHours: (surface) =>
      stored.expiryHours?.[surface] ?? PLACEMENT_SURFACES[surface].expiryHours,
    priceCapTiers: (surface) =>
      stored.priceCapTiersBySurface?.[surface] ?? stored.priceCapTiers ?? PLACEMENT_PRICE_CAP_TIERS,
  };
}

export type PlacementPriceRange = {
  min: number;
  max: number;
  score: number;
  tier: 'free' | MembershipTier;
};

/**
 * The single authority on what a creator may charge. D and E must not each
 * reimplement the score-and-tier scaling, and nothing may persist the result —
 * the cap moves the moment a membership lapses or a score is recomputed.
 */
export async function placementPriceRange(
  userId: number,
  surface: PlacementSurface
): Promise<PlacementPriceRange> {
  const [scoreRow, subscription, config] = await Promise.all([
    dbRead.$queryRaw<{ score: number | null }[]>`
      SELECT (meta -> 'scores' ->> 'total')::int AS score FROM "User" WHERE id = ${userId}
    `,
    getHighestTierSubscription(userId),
    getPlacementConfig(),
  ]);

  // `total` already nets penalties — `reportsAgainst` is stored negative — so a
  // heavily-reported creator can land below zero and gets the bottom band.
  const score = scoreRow[0]?.score ?? 0;
  const tier = toPriceCapTier(subscription?.tier);

  return {
    min: PLACEMENT_MIN_PRICE,
    max: placementPriceCap(score, tier, config.priceCapTiers(surface)),
    score,
    tier,
  };
}

const MEMBERSHIP_TIERS: MembershipTier[] = ['bronze', 'silver', 'gold'];

/** Anything unrecognised is treated as free rather than guessed upward. */
const toPriceCapTier = (tier: string | undefined): 'free' | MembershipTier =>
  MEMBERSHIP_TIERS.find((known) => known === tier) ?? 'free';
