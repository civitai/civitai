import { maxLicensingFee, VIDEO_CAP_MULTIPLIER, type CapMediaType } from './licensing-fee';

// Paid access — pure helpers shared by the main app and the creator-studio spoke.
// The gate reads ONE column, `endsAt`: active <=> endsAt IS NULL (permanent) OR endsAt > now().
// `terms` is bundle semantics (a `download` purchase grants generation too). No termsVersion —
// the zod write boundary is the contract. See docs/creator-studio/paid-access-schema.md.

export type PaidAccessEntityType = 'ModelVersion' | 'ComicChapter';

export type Grant = { price: number };

/**
 * Generation-only access for non-buyers of the `download` tier:
 *  - `{ free: true }`          → generation is free / ungated (bypasses the access check)
 *  - `{ price?, trialLimit? }` → paid generation-only tier. `price` is optional — when omitted the
 *                                effective price falls back to the `download` tier's price. `trialLimit`
 *                                is the number of free test generations before purchase is required.
 */
export type GenerationGrant = { free: true } | { price?: number; trialLimit?: number };

/** Free test generations before a paid generation-only tier requires purchase (grant default). */
export const DEFAULT_GENERATION_TRIAL_LIMIT = 10;

/**
 * ModelVersion — bundle: `download` is the full-access tier (buying it grants generation too);
 * `generation` describes how non-buyers may generate (free / cheaper paid tier); a MISSING
 * `generation` means generation is bundled with `download` (must buy it — not free).
 */
export type ModelVersionTerms = {
  download?: Grant;
  generation?: GenerationGrant;
};

/** True if generation is free/ungated (the `{ free: true }` grant). */
export const isFreeGeneration = (terms: ModelVersionTerms): boolean =>
  !!terms.generation && 'free' in terms.generation;

/** The paid generation-only tier, if any (undefined for free or bundled generation). */
export const paidGenerationGrant = (
  terms: ModelVersionTerms
): { price?: number; trialLimit?: number } | undefined =>
  terms.generation && !('free' in terms.generation) ? terms.generation : undefined;

/**
 * Effective price to purchase generation-only access: the paid tier's own `price`, or the `download`
 * tier's price when the grant leaves `price` unset. Undefined when there is no paid generation tier
 * (free or bundled generation).
 */
export const generationPrice = (terms: ModelVersionTerms): number | undefined => {
  const paid = paidGenerationGrant(terms);
  if (!paid) return undefined;
  return paid.price ?? (terms.download?.price as number | undefined);
};
/**
 * Build a ModelVersion's `terms` from an editor's pricing. "Price for access" (accessPrice) is the one
 * required charge; for a `genOnly` version (no download tier) it IS the generation price, otherwise it's
 * the download bundle price and `generationPrice` is an optional cheaper generation-only tier. The
 * generation tier always carries `trialLimit` so free preview generations apply. Shared so the onsite
 * form and Creator Studio map pricing identically.
 */
export function buildModelVersionTerms({
  accessPrice,
  generationPrice,
  freePreviewGenerations,
  genOnly = false,
  freeGeneration = false,
}: {
  accessPrice: number;
  generationPrice?: number;
  freePreviewGenerations?: number;
  genOnly?: boolean;
  /**
   * Gate the download but leave generation open to everyone — for creators who earn per generation
   * through a licensing fee and don't want to charge on top. Ignored when `genOnly`, where generation
   * IS the paid tier. A free grant carries no price or trial limit: there's nothing to sample toward.
   */
  freeGeneration?: boolean;
}): ModelVersionTerms {
  const trial = freePreviewGenerations != null ? { trialLimit: freePreviewGenerations } : {};
  if (genOnly) return { generation: { price: accessPrice, ...trial } };
  if (freeGeneration) return { download: { price: accessPrice }, generation: { free: true } };
  return {
    download: { price: accessPrice },
    generation: { ...(generationPrice != null ? { price: generationPrice } : {}), ...trial },
  };
}

/** ComicChapter — one grant: unlock/read the chapter. */
export type ComicChapterTerms = { access: Grant };

export type PaidAccessTerms = ModelVersionTerms | ComicChapterTerms;

export type PaidAccessRow = {
  entityType: PaidAccessEntityType;
  entityId: number;
  ownerId: number;
  endsAt: Date | null;
  /** Timed-window length in days; null = permanent. Materialized into endsAt at publish. */
  timeframeDays?: number | null;
  terms: PaidAccessTerms;
};

/** Active <=> permanent (no window) or the timed window is still open. */
export const isPaidAccessActive = (
  row: Pick<PaidAccessRow, 'endsAt'>,
  now: Date = new Date()
): boolean => row.endsAt == null || row.endsAt > now;

/**
 * Active *and* timed — a window that is set and still open (`endsAt > now`). Unlike `isPaidAccessActive`
 * this EXCLUDES permanent gates (endsAt null), so it answers "is there a live early-access window that
 * could end early?" — the rule shared by the donation-goal completion + the delete/merge guards.
 */
export const isTimedGateActive = (
  row: Pick<PaidAccessRow, 'endsAt'>,
  now: Date = new Date()
): boolean => row.endsAt != null && row.endsAt > now;

/**
 * Permanent <=> the gate carries no window length. `endsAt` can't answer this: a timed gate on an
 * unpublished version also has `endsAt` NULL until publish materializes it.
 */
export const isPermanentGate = (row: Pick<PaidAccessRow, 'timeframeDays'>): boolean =>
  row.timeframeDays == null;

/**
 * Free trial generations a paid generation-only tier grants before purchase (absent → default,
 * matching mini/[id].ts's COALESCE so the two endpoints agree; 0 = none).
 */
export const generationTrialLimit = (terms: ModelVersionTerms): number => {
  const grant = paidGenerationGrant(terms);
  return grant ? grant.trialLimit ?? DEFAULT_GENERATION_TRIAL_LIMIT : 0;
};

/** Whether a non-buyer may generate at all: free for everyone, or a positive trial limit. */
export const generationOpenToNonBuyers = (terms: ModelVersionTerms): boolean =>
  isFreeGeneration(terms) || generationTrialLimit(terms) > 0;

/**
 * The full generation-access decision for one viewer: an owner/mod always may; otherwise a buyer;
 * otherwise only if generation is open to non-buyers (free / trial). `hasBought` is the caller's
 * EntityAccess result — the purchase side that isn't part of the terms.
 */
export const grantsGeneration = (
  terms: ModelVersionTerms,
  { isOwnerOrMod, hasBought }: { isOwnerOrMod: boolean; hasBought: boolean }
): boolean => isOwnerOrMod || hasBought || generationOpenToNonBuyers(terms);

// Permanent pay-for-access caps (CU 868ke4949, revised by CU 868kj4q4j). Shared because two surfaces set
// permanent access — the onsite model-version form and Creator Studio — and they must agree on the limit.
// The server-side assertion in the main app is the enforcement point; these constants also drive the
// "X of Y set" capacity hints in both UIs.
//
// The gate moved from QUANTITY to PRICE: permanent access is open to everyone, and the tier caps how much
// you may charge. Only free keeps a count limit, so a non-member can try it without running a storefront.
export const PERMANENT_ACCESS_LIMIT_BY_TIER: Record<string, number> = {
  free: 3,
  // Legacy paid tier — allowances match bronze.
  founder: Infinity,
  bronze: Infinity,
  silver: Infinity,
  gold: Infinity,
};

export const PAID_ACCESS_PRICE_CAP_BY_TIER: Record<string, number> = {
  free: 500,
  // Legacy paid tier — charges as bronze.
  founder: 1000,
  bronze: 1000,
  silver: 5000,
  gold: Infinity,
};

/**
 * Concurrent permanent-access versions allowed for a tier. An unknown or lapsed tier gets the FREE
 * allowance rather than 0: a lapse must never take a gated model back to free/public (CU 868kj4q4j).
 */
export function maxPermanentAccessModels(tier: string | null | undefined): number {
  return (
    (tier ? PERMANENT_ACCESS_LIMIT_BY_TIER[tier] : undefined) ?? PERMANENT_ACCESS_LIMIT_BY_TIER.free
  );
}

/**
 * Highest price a tier may charge for PERMANENT paid access. Unknown/lapsed tiers get the FREE cap
 * (see above). Timed Early Access is not bound by it — use `paidAccessPriceCap` for a specific gate.
 */
export function maxPaidAccessPrice(
  tier: string | null | undefined,
  mediaType?: CapMediaType
): number {
  const base =
    (tier ? PAID_ACCESS_PRICE_CAP_BY_TIER[tier] : undefined) ?? PAID_ACCESS_PRICE_CAP_BY_TIER.free;
  return mediaType === 'video' ? base * VIDEO_CAP_MULTIPLIER : base;
}

/** Which side of the cap rule a gate falls on. Derive it with `isPermanentGate` when you hold a row. */
export type GateKind = { permanent: boolean };

/**
 * The price ceiling for ONE gate. Membership caps bind PERMANENT paid access only: a timed Early
 * Access window charges the creator's stored price at every tier, as it did before the caps existed.
 * Applying the tier cap to timed windows charged buyers 500 on 10k windows (CU 868kk3avk).
 */
export function paidAccessPriceCap(
  { permanent }: GateKind,
  tier: string | null | undefined,
  mediaType?: CapMediaType
): number {
  return permanent ? maxPaidAccessPrice(tier, mediaType) : Infinity;
}

// Tiers a creator can actually be shown, cheapest first. `founder` is omitted deliberately: it's a legacy
// tier nobody can buy, and every cap it has matches bronze — listing it would imply a choice that isn't one.
export const CAP_TIERS = ['free', 'bronze', 'silver', 'gold'] as const;
export type CapTier = (typeof CAP_TIERS)[number];

export const CAP_TIER_LABELS: Record<CapTier, string> = {
  free: 'Free',
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
};

/** The tier above `tier`, or null when there's nothing left to sell (gold, or an unknown tier). */
export function nextCapTier(tier: string | null | undefined): CapTier | null {
  // founder isn't in CAP_TIERS — it charges as bronze, so it upgrades like bronze.
  const current = tier === 'founder' ? 'bronze' : (tier as CapTier);
  const i = CAP_TIERS.indexOf(current);
  if (i < 0) return CAP_TIERS[1] ?? null; // unknown/lapsed prices as free, so the next step is bronze
  return i < CAP_TIERS.length - 1 ? CAP_TIERS[i + 1] : null;
}

/**
 * The row a creator should see highlighted as "you". founder isn't in CAP_TIERS (it charges as bronze), and
 * an unknown or lapsed tier prices as free — without this, those creators open the table and find no row
 * marked as theirs.
 */
export function highlightCapTier(tier: string | null | undefined): CapTier {
  if (tier === 'founder') return 'bronze';
  return CAP_TIERS.includes(tier as CapTier) ? (tier as CapTier) : 'free';
}

/**
 * Per-tier ceilings for ONE input, computed by the caller with the same expression that bounds that
 * input. Passing the function rather than a precomputed table is what stops the upsell from quoting a
 * number the field beside it contradicts — model type and media type are already baked into .
 */
export function capUpsellRows(
  capFor: (tier: CapTier) => number
): { tier: CapTier; label: string; cap: number }[] {
  return CAP_TIERS.map((tier) => ({ tier, label: CAP_TIER_LABELS[tier], cap: capFor(tier) }));
}

/** How close to the ceiling a value has to be before the upgrade nudge is worth showing. */
export const CAP_UPSELL_THRESHOLD = 0.8;

/**
 * Whether to offer "want to charge more?" beside a capped input. True only once the creator is actually
 * pressing against the ceiling — an empty or comfortably-low value gets no nudge, and neither does a tier
 * with nothing above it. Shared so the onsite form and Creator Studio surface it at the same moment.
 */
export function shouldUpsellCap({
  value,
  cap,
  tier,
}: {
  value: number | null | undefined;
  cap: number;
  tier: string | null | undefined;
}): boolean {
  if (!nextCapTier(tier)) return false;
  if (!Number.isFinite(cap) || cap <= 0) return false;
  return (value ?? 0) >= cap * CAP_UPSELL_THRESHOLD;
}

/** One tier's ceilings on one media axis. `null` = unlimited (Infinity doesn't survive serialization). */
export type TierCapAmounts = {
  /** Per-generation licensing fee ceilings, in Buzz. */
  feeCheckpoint: number;
  feeOther: number;
  paidAccessPrice: number | null;
};

export type TierCapRow = {
  tier: CapTier;
  label: string;
  image: TierCapAmounts;
  video: TierCapAmounts;
  /** Concurrent permanent gates — a count, so the video multiplier doesn't apply. `null` = unlimited. */
  permanentGates: number | null;
};

const finiteOrNull = (n: number) => (Number.isFinite(n) ? n : null);

const amountsFor = (tier: CapTier, mediaType: CapMediaType): TierCapAmounts => ({
  feeCheckpoint: maxLicensingFee(tier, 'Checkpoint', mediaType),
  feeOther: maxLicensingFee(tier, undefined, mediaType),
  paidAccessPrice: finiteOrNull(maxPaidAccessPrice(tier, mediaType)),
});

/**
 * Every tier's monetization ceilings, for display. Derived from the cap tables rather than transcribed, so
 * a table rendered from this can't drift from what the server actually enforces.
 */
export function tierCapRows(): TierCapRow[] {
  return CAP_TIERS.map((tier) => ({
    tier,
    label: CAP_TIER_LABELS[tier],
    image: amountsFor(tier, 'image'),
    video: amountsFor(tier, 'video'),
    permanentGates: finiteOrNull(maxPermanentAccessModels(tier)),
  }));
}

/**
 * Whether a monetization change needs cap headroom. Only a RAISE does: the whole version is resubmitted on
 * any edit, so rejecting every over-cap submission would make a version priced above the creator's current
 * cap unsavable — the "blocked version saves entirely" bug hot-fixed in 82f64846ba. Keeping or lowering an
 * over-cap value always passes, which is also how a lapse tightens without stranding anyone.
 */
export const raisesOverCap = (
  next: number | null | undefined,
  current: number,
  cap: number
): boolean => next != null && next > cap && next > current;

/**
 * What a buyer is actually charged on a PERMANENT gate: the stored price, lowered to whatever the
 * OWNER's current tier may charge. A lapse drops prices to the free cap without touching the stored
 * value, so re-subscribing restores the original automatically (CU 868kj4q4j). A timed gate passes
 * `permanent: false` and keeps the stored price at every tier.
 */
export function effectivePaidAccessPrice(
  storedPrice: number | null | undefined,
  ownerTier: string | null | undefined,
  opts: GateKind & { mediaType?: CapMediaType }
): number {
  if (storedPrice == null || storedPrice <= 0) return 0;
  return Math.min(storedPrice, paidAccessPriceCap(opts, ownerTier, opts.mediaType));
}

/**
 * Terms priced at the owner's current cap — what a buyer is billed. Show these to buyers; show the STORED
 * terms to the owner, whose editors write them back. A generation tier with no price of its own must keep
 * falling back to the download price, which is already capped here.
 */
export function cappedTerms(
  terms: ModelVersionTerms,
  ownerTier: string | null,
  opts: GateKind & { mediaType?: CapMediaType }
): ModelVersionTerms {
  const paidGen = paidGenerationGrant(terms);
  return {
    ...terms,
    ...(terms.download
      ? {
          download: {
            ...terms.download,
            price: effectivePaidAccessPrice(terms.download.price, ownerTier, opts),
          },
        }
      : {}),
    ...(paidGen?.price != null
      ? {
          generation: {
            ...paidGen,
            price: effectivePaidAccessPrice(paidGen.price, ownerTier, opts),
          },
        }
      : {}),
  };
}

/** A gate's two chargeable prices (0 when absent). Kept separate so a cheap tier can't ride an over-cap one. */
export function gatePrices(terms: ModelVersionTerms | undefined | null): {
  download: number;
  generation: number;
} {
  const gen = terms?.generation && !('free' in terms.generation) ? terms.generation : undefined;
  return { download: terms?.download?.price ?? 0, generation: gen?.price ?? 0 };
}
