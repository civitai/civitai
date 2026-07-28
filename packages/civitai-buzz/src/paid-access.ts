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

