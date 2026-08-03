import { z } from 'zod';
import { dbRead } from '~/server/db/client';
import { getCapTier } from '~/server/services/subscriptions.service';
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
      clampExpiryHours(stored.expiryHours?.[surface], PLACEMENT_SURFACES[surface].expiryHours),
    priceCapTiers: (surface) =>
      usablePriceCapTiers(stored.priceCapTiersBySurface?.[surface] ?? stored.priceCapTiers),
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
  const [scoreRow, capTier, config] = await Promise.all([
    // Cast through `numeric`: `::int` on a stored value that isn't integer text
    // raises rather than returning null, and this read shouldn't be able to fail
    // on one malformed row.
    dbRead.$queryRaw<{ score: number | null }[]>`
      SELECT floor((meta -> 'scores' ->> 'total')::numeric)::int AS score
      FROM "User" WHERE id = ${userId}
    `,
    // Not `getHighestTierSubscription`, which keeps bad-state subscriptions: a
    // creator mid-failed-payment would price against a tier they aren't paying
    // for, while the UI showed them the free cap. Every other monetization cap
    // in the app resolves through this helper.
    getCapTier(userId),
    getPlacementConfig(),
  ]);

  // `total` already nets penalties — `reportsAgainst` is stored negative — so a
  // heavily-reported creator can land below zero and gets the bottom band.
  const score = scoreRow[0]?.score ?? 0;
  const tier = toPriceCapTier(capTier ?? undefined);

  return {
    min: PLACEMENT_MIN_PRICE,
    max: placementPriceCap(score, tier, config.priceCapTiers(surface)),
    score,
    tier,
  };
}

/**
 * Escrow with no timeout is money frozen indefinitely, which is the whole reason
 * expiry exists — so an operator typo of `8760` must not quietly become a year
 * of held Buzz.
 */
export const MIN_EXPIRY_HOURS = 1;
export const MAX_EXPIRY_HOURS = 24 * 14;

const clampExpiryHours = (hours: number | undefined, fallback: number) => {
  if (typeof hours !== 'number' || !Number.isFinite(hours)) return fallback;
  return Math.min(Math.max(hours, MIN_EXPIRY_HOURS), MAX_EXPIRY_HOURS);
};

/**
 * A stored table whose lowest band starts above zero gives every creator beneath
 * it a cap of 0, i.e. a space nobody can be charged for. It fails toward free
 * rather than toward overcharging, but silently, and the schema can't see it.
 */
const usablePriceCapTiers = (tiers: PlacementPriceTier[] | undefined) =>
  tiers?.some((tier) => tier.minScore === 0) ? tiers : PLACEMENT_PRICE_CAP_TIERS;

const MEMBERSHIP_TIERS: MembershipTier[] = ['bronze', 'silver', 'gold'];

/** Anything unrecognised is treated as free rather than guessed upward. */
const toPriceCapTier = (tier: string | undefined): 'free' | MembershipTier =>
  MEMBERSHIP_TIERS.find((known) => known === tier) ?? 'free';
