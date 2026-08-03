import type { MembershipTier } from '~/shared/utils/subscription-tokens';

/**
 * A creator-owned space someone pays to occupy. Stickers on an image and the
 * remix gallery are two instances of it, and nothing in this module knows which
 * is which — a surface supplies its own payload and render, and reaches this
 * layer only through the table below.
 */
export type PlacementSurface = 'sticker' | 'remixGallery';

/** Where a space can be configured. Resolution runs image -> post -> account. */
export type PlacementSpaceEntity = 'image' | 'post' | 'user';

export type PlacementSpaceMode =
  /** Nothing may be placed. */
  | 'off'
  /** Placements arrive pending; the owner approves or declines. */
  | 'review'
  /** Placements go live on payment. */
  | 'auto';

export type PlacementStatus = 'pending' | 'approved' | 'declined' | 'expired' | 'removed';

/**
 * Who removed a placement, stored alongside `status: 'removed'`.
 *
 * The two removals have opposite money outcomes — an owner removing an
 * auto-approved placement refunds in full, a moderator removing an abusive one
 * refunds nothing — so `removed` alone cannot tell a reconcile or a retry which
 * one happened.
 */
export type PlacementRemovedBy = 'owner' | 'moderator';

/**
 * Everything that varies per surface, in one table — the shape v1's
 * `STICKER_SURFACES` earned. **A surface absent from this table is denied
 * everywhere**, which is the property the table exists for; adding one must be
 * a deliberate edit here rather than a string that happens to reach a query.
 */
export const PLACEMENT_SURFACES = {
  sticker: {
    label: 'stickers',
    targets: ['image'],
    defaultMode: 'off',
    defaultDeclineFeeRate: 0.3,
    expiryHours: 48,
  },
  remixGallery: {
    label: 'remix galleries',
    targets: ['image'],
    defaultMode: 'off',
    defaultDeclineFeeRate: 0.3,
    expiryHours: 48,
  },
} as const satisfies Record<
  PlacementSurface,
  {
    label: string;
    targets: readonly PlacementSpaceEntity[];
    defaultMode: PlacementSpaceMode;
    defaultDeclineFeeRate: number;
    expiryHours: number;
  }
>;

export const placementSurfaces = Object.keys(PLACEMENT_SURFACES) as PlacementSurface[];

export const isPlacementSurface = (surface: string): surface is PlacementSurface =>
  surface in PLACEMENT_SURFACES;

export const surfaceAcceptsTarget = (surface: PlacementSurface, target: string) =>
  (PLACEMENT_SURFACES[surface].targets as readonly string[]).includes(target);

/**
 * Read the copy from the table so a surface that isn't listed cannot be named
 * in the UI. v1's uses tooltip promised "articles", which were deliberately not
 * a sticker surface; deriving the wording is what makes that unsayable.
 */
export const placementSurfaceLabel = (surface: PlacementSurface) =>
  PLACEMENT_SURFACES[surface].label;

// ---------------------------------------------------------------------------
// Space resolution
// ---------------------------------------------------------------------------

export type PlacementSpaceSetting = { mode: PlacementSpaceMode; price: number | null };

/**
 * Image beats post beats account. A post-level row also covers images added to
 * the post later, which is why the levels inherit rather than the post toggle
 * writing a row per image.
 *
 * `price` resolves independently of `mode`: an owner who priced at the account
 * level and only flipped a single image on should not lose their price.
 */
export function resolvePlacementSpace(
  surface: PlacementSurface,
  levels: {
    image?: PlacementSpaceSetting;
    post?: PlacementSpaceSetting;
    user?: PlacementSpaceSetting;
  }
): PlacementSpaceSetting {
  const ordered = [levels.image, levels.post, levels.user];
  return {
    mode:
      ordered.find((level) => level?.mode !== undefined)?.mode ??
      PLACEMENT_SURFACES[surface].defaultMode,
    price: ordered.find((level) => level?.price != null)?.price ?? null,
  };
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export type PlacementPriceTier = { minScore: number; caps: Record<PriceCapTier, number> };
type PriceCapTier = 'free' | MembershipTier;

/**
 * What a creator may charge, capped by creator score and membership tier. The
 * creator sets the price; this only ceilings it.
 *
 * ⚠️ The numbers are placeholders pending a product decision. The shape is the
 * commitment: read at request time, overridable through `KeyValue` without a
 * deploy, and never written to a placement row.
 */
export const PLACEMENT_PRICE_CAP_TIERS: PlacementPriceTier[] = [
  { minScore: 0, caps: { free: 100, bronze: 200, silver: 300, gold: 500 } },
  { minScore: 5_000, caps: { free: 250, bronze: 500, silver: 750, gold: 1_000 } },
  { minScore: 25_000, caps: { free: 500, bronze: 1_000, silver: 1_500, gold: 2_500 } },
  { minScore: 100_000, caps: { free: 1_000, bronze: 2_000, silver: 3_000, gold: 5_000 } },
];

export const PLACEMENT_MIN_PRICE = 0;

export function placementPriceCap(
  score: number,
  tier: PriceCapTier,
  tiers: PlacementPriceTier[] = PLACEMENT_PRICE_CAP_TIERS
) {
  const usable = Number.isFinite(score) ? Math.max(score, 0) : 0;
  const band = [...tiers]
    .sort((a, b) => a.minScore - b.minScore)
    .reduce<PlacementPriceTier | null>(
      (best, candidate) => (usable >= candidate.minScore ? candidate : best),
      null
    );
  return band?.caps[tier] ?? 0;
}

/**
 * The effective price is `min(set, cap)` computed here at read. Storing it would
 * go stale the moment a membership lapses or a score moves, with nothing failing
 * to say so.
 *
 * An unset price is `null`, not the cap. The creator sets the price and the cap
 * only ceilings it, so defaulting an unpriced space to its maximum inverts that
 * — callers must decide what an unpriced space does rather than charge for one.
 */
export const effectivePlacementPrice = (setPrice: number | null, cap: number) =>
  setPrice == null ? null : Math.max(Math.min(setPrice, cap), PLACEMENT_MIN_PRICE);

// ---------------------------------------------------------------------------
// The split
// ---------------------------------------------------------------------------

export type PlacementOutcome =
  | 'approved'
  | 'declined'
  | 'expired'
  | 'removedByOwner'
  | 'removedByModerator';

export type PlacementSplitInput = {
  /** Integer Buzz the placer paid into escrow. */
  amount: number;
  outcome: PlacementOutcome;
  /** Operator-set, per surface. Clamped by `clampDeclineFeeRate` before it gets here. */
  declineFeeRate: number;
  /** Share of an approved placement paid to whoever sold the placed thing. */
  sellerShare: number;
  platformShare: number;
};

export type PlacementSplit = {
  toOwner: number;
  toSeller: number;
  toPlatform: number;
  toPlacer: number;
};

const isNonNegativeInt = (value: number) => Number.isSafeInteger(value) && value >= 0;
const isRate = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;

/**
 * Splits what a placer paid, for every release path.
 *
 * The invariant, from Demian: **the total paid out can never exceed what the
 * placer spent.** Every branch here therefore derives one component as the
 * remainder rather than computing all of them, so no combination of rates and
 * rounding can sum past `amount`. It throws on out-of-range input instead of
 * clamping — a bad operator config should stop placements, not quietly mint.
 */
export function splitPlacementPayment(input: PlacementSplitInput): PlacementSplit {
  const { amount, outcome, declineFeeRate, sellerShare, platformShare } = input;

  if (!isNonNegativeInt(amount))
    throw new Error(`placement split: amount must be a non-negative integer, got ${amount}`);
  if (!isRate(declineFeeRate))
    throw new Error(`placement split: declineFeeRate out of range: ${declineFeeRate}`);
  if (!isRate(sellerShare) || !isRate(platformShare))
    throw new Error(
      `placement split: shares out of range: seller=${sellerShare} platform=${platformShare}`
    );
  if (sellerShare + platformShare > 1)
    throw new Error(
      `placement split: seller + platform shares exceed the payment: ${sellerShare} + ${platformShare}`
    );

  const nothing: PlacementSplit = { toOwner: 0, toSeller: 0, toPlatform: 0, toPlacer: 0 };

  switch (outcome) {
    case 'approved': {
      const toSeller = Math.floor(amount * sellerShare);
      const toPlatform = Math.floor(amount * platformShare);
      // Rounding dust lands on the space owner, following the creator shop's
      // convention of rounding in the creator's favour.
      return { ...nothing, toSeller, toPlatform, toOwner: amount - toSeller - toPlatform };
    }
    case 'declined': {
      const toOwner = declineFeeAmount(amount, declineFeeRate);
      return { ...nothing, toOwner, toPlacer: amount - toOwner };
    }
    // Neither cost the owner any attention, so neither pays a fee. Removing an
    // auto-approved placement pays nothing on purpose: a fee there would reward
    // accepting placements, banking the money and sweeping them off later.
    case 'expired':
    case 'removedByOwner':
      return { ...nothing, toPlacer: amount };
    // Not returned — the placement was abusive. It is forfeit rather than paid
    // to the owner, so a removal no one benefits from stays uninteresting to game.
    case 'removedByModerator':
      return { ...nothing, toPlatform: amount };
    // `outcome` arrives from a schemaless TEXT column, so the switch has to
    // refuse an unknown value rather than fall off the end returning undefined —
    // a caller destructuring the result would pay nobody and swallow it.
    default:
      throw new Error(`placement split: unknown outcome ${JSON.stringify(outcome)}`);
  }
}

/**
 * The stored status back to the outcome that decides the money. `removed` is
 * ambiguous on its own — the two removals refund opposite amounts — so it must
 * be resolved with the actor rather than guessed.
 */
export function placementOutcomeFromStatus(
  status: PlacementStatus,
  removedBy?: PlacementRemovedBy | null
): PlacementOutcome {
  switch (status) {
    case 'approved':
      return 'approved';
    case 'declined':
      return 'declined';
    case 'expired':
      return 'expired';
    case 'removed':
      if (removedBy === 'owner') return 'removedByOwner';
      if (removedBy === 'moderator') return 'removedByModerator';
      throw new Error('placement outcome: a removed placement must record who removed it');
    case 'pending':
      throw new Error('placement outcome: a pending placement has no settled outcome');
    default:
      throw new Error(`placement outcome: unknown status ${JSON.stringify(status)}`);
  }
}

/**
 * The fee exists to stop submission spam, so it must not round away to nothing
 * on a cheap placement — at a 5% rate anything under 20⚡ would floor to zero.
 */
export function declineFeeAmount(amount: number, rate: number) {
  if (rate <= 0 || amount <= 0) return 0;
  return Math.min(amount, Math.max(1, Math.floor(amount * rate)));
}

/**
 * A free decline defeats the fee, and a confiscatory one makes declining
 * profitable. Both bounds are enforced here rather than trusting whoever edits
 * the operator config.
 */
export const MIN_DECLINE_FEE_RATE = 0.05;
export const MAX_DECLINE_FEE_RATE = 0.5;

export const clampDeclineFeeRate = (rate: number | null | undefined, fallback: number) => {
  const value = typeof rate === 'number' && Number.isFinite(rate) ? rate : fallback;
  return Math.min(Math.max(value, MIN_DECLINE_FEE_RATE), MAX_DECLINE_FEE_RATE);
};
