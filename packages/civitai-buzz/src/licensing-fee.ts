// Licensing fees — the shared source of truth for both the main app and the creator-studio spoke.
//
// Creators express a licensing fee as a whole-number ratio — "N ⚡ per M images" — never a decimal.
// The stored/charged value is per-image (buzz ÷ images) at the ModelVersion.licensingFee DECIMAL(10,2)
// column's 0.01 precision; this module is the only place that converts between the two.
// Browser-safe and dependency-free — importable from client, server, and any spoke.

/** Ceiling for a per-image licensing fee, in Buzz. Mirrored by the app's model-version schema. */
export const MAX_LICENSING_FEE = 100;

export type FeeRatio = { buzz: number; images: number };

// Image-count denominators the creator UI offers (a select, not a free input). Every stored fee maps
// onto one of these — see feeToRatio, which is driven by this list, so adding a value here (e.g. 20, 50)
// is all it takes. Keep sorted ascending, and keep 100 (the finest at the 0.01 column precision) so
// every fee stays exactly representable. DEFAULT_FEE_IMAGES seeds new/off inputs.
export const FEE_IMAGE_OPTIONS = [1, 10, 20, 50, 100] as const;
export const DEFAULT_FEE_IMAGES = 10;

// Stored per-image fee → a whole-number "buzz per images" pair whose denominator is one of
// FEE_IMAGE_OPTIONS. Integer-hundredths math (the column is 0.01 precision) stays float-safe; pick the
// smallest offered denominator that keeps buzz whole: 1 → {1,1}, 0.1 → {1,10}, 0.5 → {5,10},
// 0.05 → {1,20}, 0.01 → {1,100}. `null`/0 → off.
export function feeToRatio(perImage: number | null | undefined): FeeRatio {
  if (perImage == null || perImage <= 0) return { buzz: 0, images: DEFAULT_FEE_IMAGES };
  const cents = Math.round(perImage * 100);
  for (const images of FEE_IMAGE_OPTIONS) {
    if ((cents * images) % 100 === 0) return { buzz: (cents * images) / 100, images };
  }
  // Unreachable while 100 ∈ FEE_IMAGE_OPTIONS (cents*100 % 100 === 0 always); guards a mislisted set.
  const images = FEE_IMAGE_OPTIONS[FEE_IMAGE_OPTIONS.length - 1];
  return { buzz: Math.round((cents * images) / 100), images };
}

// "N ⚡ per M images" → per-image fee at 0.01 precision (0 clears). buzz(int) / images(∈ FEE_IMAGE_OPTIONS) is
// always a multiple of 0.01, so it satisfies the column + the schema's multipleOf(0.01). Inverse of feeToRatio.
export function ratioToFee(buzz: number, images: number): number {
  if (!buzz || buzz <= 0 || !images) return 0;
  return Math.round((buzz / images) * 100) / 100;
}

// Suggested per-image fee by model type — the seeded default for a NEW version. Checkpoints carry more value;
// everything else is 0.1 ⚡/image (= 1 ⚡ per 10 images).
export const SUGGESTED_FEE_PER_IMAGE: Record<string, number> = { Checkpoint: 1 };
export const DEFAULT_SUGGESTED_FEE_PER_IMAGE = 0.1;
export function suggestedFeePerImage(modelType: string | null | undefined): number {
  return (modelType ? SUGGESTED_FEE_PER_IMAGE[modelType] : undefined) ?? DEFAULT_SUGGESTED_FEE_PER_IMAGE;
}

// Per-tier ceiling on the per-image licensing fee (CU 868kj4q49). Anyone may set a fee — including free
// users — and the tier decides only HOW MUCH, replacing the old "Creator Program members only" gate.
//
// Shaped like SUGGESTED_FEE_PER_IMAGE: checkpoints carry more value, everything else takes `default`.
const BRONZE_FEE_CAP = { checkpoint: 3, default: 1 };
export const LICENSING_FEE_CAP_BY_TIER: Record<string, { checkpoint: number; default: number }> = {
  free: { checkpoint: 1, default: 0.1 },
  // Legacy paid tier — charges as bronze.
  founder: BRONZE_FEE_CAP,
  bronze: BRONZE_FEE_CAP,
  silver: { checkpoint: 10, default: 5 },
  gold: { checkpoint: MAX_LICENSING_FEE, default: MAX_LICENSING_FEE },
};

/**
 * Highest per-image fee `tier` may charge for `modelType`. An unknown or lapsed tier gets the FREE cap, so
 * a lapse tightens the ceiling without a migration and can never ungate anything.
 */
export function maxLicensingFee(
  tier: string | null | undefined,
  modelType?: string | null
): number {
  const caps = (tier ? LICENSING_FEE_CAP_BY_TIER[tier] : undefined) ?? LICENSING_FEE_CAP_BY_TIER.free;
  return modelType === 'Checkpoint' ? caps.checkpoint : caps.default;
}

/**
 * The cap in the editor's whole-number domain. Fees are entered as an integer "N ⚡ per M generations"
 * ratio, so a fractional per-image cap (free/other is 0.1) has no valid entry at small denominators —
 * capping in the per-image domain instead lets the UI offer 0.1 and the integer schema then rejects it.
 */
export function maxFeeBuzzForRatio(
  tier: string | null | undefined,
  modelType: string | null | undefined,
  images: number
): number {
  return Math.floor(maxLicensingFee(tier, modelType) * images);
}

/** Denominators from FEE_IMAGE_OPTIONS that can express at least 1 ⚡ under this tier's cap. */
export function feeImageOptionsForCap(
  tier: string | null | undefined,
  modelType?: string | null
): number[] {
  const usable = FEE_IMAGE_OPTIONS.filter((n) => maxFeeBuzzForRatio(tier, modelType, n) >= 1);
  // Never return an empty select: the coarsest denominator is the most expressive.
  return usable.length ? [...usable] : [FEE_IMAGE_OPTIONS[FEE_IMAGE_OPTIONS.length - 1]];
}

// Fees can be charged per image, per video, etc., so the cadence noun stays media-agnostic:
// one "generation" covers every output type without needing to know which.
const FEE_UNIT_NOUN = 'generation';

/** Spoken cadence: "per generation" / "per 10 generations". */
export function formatFeeCadence(count: number): string {
  return count === 1 ? `per ${FEE_UNIT_NOUN}` : `per ${count} ${FEE_UNIT_NOUN}s`;
}

/** Read-only label for a stored per-unit fee: "1 ⚡ / generation", "5 ⚡ / 10 generations", or "Off". */
export function formatFeeRatio(perImage: number | null | undefined): string {
  if (perImage == null || perImage <= 0) return 'Off';
  const { buzz, images } = feeToRatio(perImage);
  return images === 1
    ? `${buzz} ⚡ / ${FEE_UNIT_NOUN}`
    : `${buzz} ⚡ / ${images} ${FEE_UNIT_NOUN}s`;
}
