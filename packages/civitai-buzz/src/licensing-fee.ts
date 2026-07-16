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
