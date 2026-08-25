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
  /** Owner opt-in to ALSO accepting Blue Buzz, at the same price — and to being paid in it. */
  acceptsBlueBuzz?: boolean;
};

export const acceptsBlueBuzz = (terms: ModelVersionTerms | undefined | null): boolean =>
  !!terms?.acceptsBlueBuzz;

/**
 * Shared so the onsite form and Creator Studio can't drift on what a creator was told they're
 * agreeing to — the opt-in trades bankable income for credit that can never be withdrawn.
 */
export const ACCEPTS_BLUE_BUZZ_HINT =
  'Buyers can pay the same price with Blue Buzz. You are paid in Blue Buzz for those purchases — it can be spent on generation but cannot be withdrawn or converted to cash.';

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
 * Model-level monetization policy, shared so the main app, its REST endpoint and Creator Studio can't
 * disagree about who may charge. A model depicting a real person may not be sold at all; a private model
 * has no audience to sell to, but may still carry a per-generation fee for when it is published.
 *
 * `availability` is the Prisma enum as a string, so a caller can pass a row straight from either app.
 */
export type MonetizationSubject = { poi?: boolean | null; availability?: string | null };

/** A paid-access gate is refused for a POI model and for a private one. */
export const paidAccessBlockedFor = (model: MonetizationSubject): boolean =>
  !!model.poi || model.availability === 'Private';

/** A per-generation licensing fee is refused for a POI model. Private models keep theirs. */
export const licensingFeeBlockedFor = (model: MonetizationSubject): boolean => !!model.poi;

/**
 * Whether a chosen "cheaper generation-only price" is missing the price it promises. Such a grant is
 * indistinguishable in `terms` from generation bundled with the download, and `generationPrice` prices
 * both at the download price — so an editor must refuse the write rather than store the choice.
 */
export const separateGenerationPriceMissing = (price: number | null | undefined): boolean =>
  price == null || !Number.isFinite(price) || price <= 0;

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
  acceptsBlueBuzz = false,
}: {
  accessPrice: number;
  generationPrice?: number;
  freePreviewGenerations?: number;
  genOnly?: boolean;
  acceptsBlueBuzz?: boolean;
  /**
   * Gate the download but leave generation open to everyone — for creators who earn per generation
   * through a licensing fee and don't want to charge on top. Ignored when `genOnly`, where generation
   * IS the paid tier. A free grant carries no price or trial limit: there's nothing to sample toward.
   */
  freeGeneration?: boolean;
}): ModelVersionTerms {
  const trial = freePreviewGenerations != null ? { trialLimit: freePreviewGenerations } : {};
  const blue = acceptsBlueBuzz ? { acceptsBlueBuzz: true } : {};
  if (genOnly) return { ...blue, generation: { price: accessPrice, ...trial } };
  if (freeGeneration)
    return { ...blue, download: { price: accessPrice }, generation: { free: true } };
  return {
    ...blue,
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
  /** Scheduled sales covering this entity — windows only, never a resolved price. See discountedTerms. */
  sales?: ModelVersionSaleWindow[];
};

/**
 * A gate that never expires. Reads timeframeDays, NOT endsAt: a timed gate on an unpublished version also
 * carries endsAt null until publish materializes it, so endsAt cannot tell the two kinds apart.
 *
 * The price ceiling turns on this — a timed early-access window prices itself out when the window closes,
 * so only a permanent gate is capped.
 */
export const isPermanentGate = (row: Pick<PaidAccessRow, 'timeframeDays'>): boolean =>
  row.timeframeDays == null;

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
export function nextCapTier(tier: CapTier): CapTier | null {
  return CAP_TIERS[CAP_TIERS.indexOf(tier) + 1] ?? null;
}

/**
 * Whether a change needs ceiling headroom. Only a RAISE does: the whole version is resubmitted on any
 * edit, so rejecting every over-ceiling submission would make a version priced above the current ceiling
 * unsavable — the "blocked version saves entirely" bug hot-fixed in 82f64846ba. Keeping or lowering an
 * over-ceiling value always passes, which is what grandfathers a price set when the ceiling was higher.
 */
export const raisesOverCap = (
  next: number | null | undefined,
  current: number,
  cap: number
): boolean => next != null && next > cap && next > current;

/** A gate's two chargeable prices (0 when absent). */
export function gatePrices(terms: ModelVersionTerms | undefined | null): {
  download: number;
  generation: number;
} {
  const gen = terms?.generation && !('free' in terms.generation) ? terms.generation : undefined;
  return { download: terms?.download?.price ?? 0, generation: gen?.price ?? 0 };
}

/**
 * Move a gate's price onto the tier that survives a usage-control change.
 *
 * A gen-only version can't carry a download tier, but refusing the write strands the creator: they have to
 * go clear a price by hand before the switch they asked for will take. Creator Studio has always migrated;
 * this is the same rule for the main app so the two can't disagree.
 *
 * Returns the terms unchanged when nothing needs moving.
 */
export function migrateTermsForUsageControl(
  terms: ModelVersionTerms | undefined | null,
  genOnly: boolean
): ModelVersionTerms | undefined | null {
  if (!terms || !genOnly || !terms.download) return terms;
  const { download, generation, ...rest } = terms;
  // A free grant is a deliberate choice and outranks an inherited price — a gen-only version that gives
  // generation away keeps doing so, it just loses the download tier.
  if (generation && 'free' in generation) return { ...rest, generation };
  return {
    ...rest,
    generation: {
      price: generation?.price ?? download.price,
      trialLimit: generation?.trialLimit ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Scheduled sales (CU 868ktk1ku)
// ---------------------------------------------------------------------------

export type SaleDiscountKind = 'Fixed' | 'Percent';

/** One scheduled discount over a version. Windows only — an effective price is never stored. */
export type ModelVersionSaleWindow = {
  id: number;
  discountType: SaleDiscountKind;
  /** Buzz for Fixed, whole percent for Percent. */
  discountAmount: number;
  startsAt: Date;
  endsAt: Date;
  canceledAt?: Date | null;
};

/**
 * Sale-days a tier may have discounted per month. Shared for the same reason the caps above are: Creator
 * Studio authors sales and the main app prices them, and a limit only one of them knows is not a limit.
 */
export const SALE_DAYS_BY_TIER: Record<string, number> = {
  free: 3,
  // Legacy paid tier — allowances match bronze.
  founder: 7,
  bronze: 7,
  silver: 14,
  gold: 30,
};

/**
 * Creator score (`User.meta.scores.models`) required to charge for anything — a new price, or a sale.
 *
 * Deliberately NOT waived for moderators: it states who may sell here, not a permission level.
 * The sale gate reads it via `minCreatorScoreForSale`, which a KeyValue override can move without a
 * deploy; the pricing gate has no override.
 */
export const MONETIZATION_MIN_CREATOR_SCORE = 10_000;

/** How far ahead a sale may be scheduled, so next month's promo can be prepared from the back half of this one. */
export const MAX_SALE_LEAD_DAYS = 14;

/**
 * KeyValue row both apps read the sale limits from, so a limit can move without a deploy and a pricing page
 * can state it without hard-coding it. The tables above are the defaults when the row is absent or partial.
 */
export const SALE_LIMITS_KEY = 'sale-limits';

export type SaleLimitOverrides = {
  saleDaysByTier?: Record<string, number>;
  minCreatorScore?: number;
  maxLeadDays?: number;
};

/**
 * Sale-days a tier gets. An unknown or lapsed tier gets the FREE allowance rather than 0, as with access
 * caps — a lapse must not retroactively invalidate a scheduled sale.
 */
export function maxSaleDays(
  tier: string | null | undefined,
  overrides?: SaleLimitOverrides
): number {
  const table = { ...SALE_DAYS_BY_TIER, ...(overrides?.saleDaysByTier ?? {}) };
  return (tier ? table[tier] : undefined) ?? table.free;
}

export const minCreatorScoreForSale = (overrides?: SaleLimitOverrides): number =>
  overrides?.minCreatorScore ?? MONETIZATION_MIN_CREATOR_SCORE;

export const maxSaleLeadDays = (overrides?: SaleLimitOverrides): number =>
  overrides?.maxLeadDays ?? MAX_SALE_LEAD_DAYS;

/** Live at `now`: started, not yet ended, not cancelled before this moment. */
export const isSaleActive = (sale: ModelVersionSaleWindow, now: Date = new Date()): boolean =>
  sale.startsAt <= now && sale.endsAt > now && (sale.canceledAt == null || sale.canceledAt > now);

/**
 * What one sale takes off a price. `Math.min(price, off)` is what keeps a fixed discount from making a
 * price negative; the outer `Math.max(0, …)` floors it at free.
 *
 * Percent is FLOORED, which rounds the leftover in the seller's favour — 33% of 33 takes 10 off, not 11,
 * so the buyer pays 23. That is deliberate (an integer currency has to break the tie somewhere and the
 * creator is the one being paid), but it is the opposite of what "in the buyer's favour" would mean, so
 * do not switch this to Math.round on the assumption it is a wash.
 */
export function saleDiscountFor(price: number, sale: ModelVersionSaleWindow): number {
  if (price <= 0) return 0;
  const off =
    sale.discountType === 'Percent'
      ? Math.floor((price * sale.discountAmount) / 100)
      : sale.discountAmount;
  return Math.max(0, Math.min(price, off));
}

/**
 * The sale a buyer should get at `now`: the one that takes the most off. Sales may overlap — a sale
 * crossing a month boundary meets the next month's, and both spent their own budget — so the deepest
 * discount wins rather than whichever row came back first. Percent and fixed are compared at a price,
 * not against each other, because 20% and 200 Buzz have no order until you know what they apply to.
 */
export function bestSaleFor(
  price: number,
  sales: ModelVersionSaleWindow[] | undefined | null,
  now: Date = new Date()
): ModelVersionSaleWindow | undefined {
  let best: ModelVersionSaleWindow | undefined;
  let bestOff = 0;
  for (const sale of sales ?? []) {
    if (!isSaleActive(sale, now)) continue;
    const off = saleDiscountFor(price, sale);
    if (off > bestOff) {
      best = sale;
      bestOff = off;
    }
  }
  return best;
}

/** Buzz a sale can never take a purchase below. */
export const MIN_SALE_PRICE = 1;

/**
 * One price with the best active sale applied. The charge and every display path call THIS — the repo has
 * already paid for the alternative once (see computePackAmountDue: "the button subtracted a discount the
 * server never applied"), and two implementations of the same arithmetic had already diverged here on the
 * floor before a review caught it.
 *
 * Floors at 1, not 0: a zero-Buzz purchase writes no ledger row, and the 30-day refund path reads amounts
 * back from the ledger, so a free purchase would be unrefundable and invisible to reporting.
 */
export function discountedPrice(
  price: number,
  sales: ModelVersionSaleWindow[] | undefined | null,
  now: Date = new Date()
): number {
  const sale = bestSaleFor(price, sales, now);
  if (!sale) return price;
  return Math.max(MIN_SALE_PRICE, price - saleDiscountFor(price, sale));
}

/**
 * Terms with any active sale applied — what a buyer pays, discounted off the stored price.
 *
 * Applies to BOTH chargeable prices. A generation tier with no price of its own falls back to the download
 * price, which is discounted here already, so it follows automatically.
 */
export function discountedTerms(
  terms: ModelVersionTerms,
  sales: ModelVersionSaleWindow[] | undefined | null,
  now: Date = new Date()
): ModelVersionTerms {
  if (!sales?.length) return terms;
  const paidGen = paidGenerationGrant(terms);
  const discount = (price: number) => discountedPrice(price, sales, now);
  return {
    ...terms,
    ...(terms.download
      ? { download: { ...terms.download, price: discount(terms.download.price) } }
      : {}),
    ...(paidGen?.price != null
      ? { generation: { ...paidGen, price: discount(paidGen.price) } }
      : {}),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whole days a sale takes out of the budget: its scheduled length, shortened to where it was actually
 * cancelled. A sale reserves its full window when scheduled and RETURNS the untaken tail if it is cancelled
 * or cut short — cancel before it starts and it costs nothing. Without that return, "you may always cut a
 * sale short" would cost the creator exactly as much as running it in full, and the permission would be
 * worth nothing. Rounded up, so a run of half-day sales can't slice past the budget.
 */
export function saleDaysCharged(sale: ModelVersionSaleWindow): number {
  const end =
    sale.canceledAt != null && sale.canceledAt < sale.endsAt ? sale.canceledAt : sale.endsAt;
  const ms = end.getTime() - sale.startsAt.getTime();
  return ms <= 0 ? 0 : Math.ceil(ms / DAY_MS);
}

/**
 * Sale-days a creator has spent in the month a sale STARTS in. Counting by start month is what lets a sale
 * cross a month boundary without costing twice — the alternative refuses a sale for reaching into a month
 * whose budget is untouched, which reads as a bug to the creator.
 */
export function saleDaysUsed(
  sales: ModelVersionSaleWindow[] | undefined | null,
  month: Date
): number {
  const year = month.getUTCFullYear();
  const mon = month.getUTCMonth();
  return (sales ?? [])
    .filter((s) => s.startsAt.getUTCFullYear() === year && s.startsAt.getUTCMonth() === mon)
    .reduce((total, s) => total + saleDaysCharged(s), 0);
}

/** Sale-days left in `month` for a tier. Never negative — a tier downgrade must not read as debt. */
export function remainingSaleDays(
  tier: string | null | undefined,
  sales: ModelVersionSaleWindow[] | undefined | null,
  month: Date,
  overrides?: SaleLimitOverrides
): number {
  return Math.max(0, maxSaleDays(tier, overrides) - saleDaysUsed(sales, month));
}
