// Paid access — pure helpers shared by the main app and the creator-studio spoke.
// The gate reads ONE column, `endsAt`: active <=> endsAt IS NULL (permanent) OR endsAt > now().
// `terms` is bundle semantics (a `download` purchase grants generation too). No termsVersion —
// the zod write boundary is the contract. See docs/creator-studio/paid-access-schema.md.

export type PaidAccessEntityType = 'ModelVersion' | 'ComicChapter';

export type Grant = { price: number };

/**
 * Generation-only access for non-buyers of the `download` tier:
 *  - `{ free: true }`         → generation is free / ungated
 *  - `{ price, trialLimit? }` → paid generation-only tier (+ optional free trials)
 */
export type GenerationGrant = { free: true } | { price: number; trialLimit?: number };

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
): { price: number; trialLimit?: number } | undefined =>
  terms.generation && 'price' in terms.generation ? terms.generation : undefined;
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
 * SQL EXISTS predicate for filter/sort/count queries — "is `<alias>` gated right now?".
 * `alias` must expose `.id`; `entityType` is a typed literal so there's no injection surface.
 */
export const paidAccessActiveSql = (alias: string, entityType: PaidAccessEntityType): string =>
  `EXISTS (SELECT 1 FROM "PaidAccess" pa WHERE pa."entityType" = '${entityType}' AND pa."entityId" = ${alias}.id AND (pa."endsAt" IS NULL OR pa."endsAt" > now()))`;

/** entityType-dispatched terms normalizer. `raw` is trusted jsonb the write path validated. */
export function parseTerms(entityType: PaidAccessEntityType, raw: unknown): PaidAccessTerms {
  const t = (raw ?? {}) as Record<string, unknown>;
  if (entityType === 'ComicChapter') {
    return { access: (t.access as Grant) ?? { price: 0 } };
  }
  return {
    download: t.download as Grant | undefined,
    generation: t.generation as GenerationGrant | undefined,
  };
}

/** Effective price (promotions deferred → the standard price). */
export const effectivePrice = (grant: Grant | undefined): number | undefined => grant?.price;

/** True if this ModelVersion's terms gate generation behind payment (i.e. generation isn't free). */
export const generationGatedByTerms = (terms: ModelVersionTerms): boolean =>
  !isFreeGeneration(terms);
