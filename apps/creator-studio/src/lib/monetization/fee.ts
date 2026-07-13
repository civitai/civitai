// Creators express a licensing fee as a whole-number ratio — "N ⚡ per M images" — never a decimal (Justin).
// The stored/charged value is still per-image (buzz ÷ images) at the DECIMAL(10,2) column's 0.01 precision;
// this module is the only place that converts between the two. Shared (client + server) — no server imports.
//
// Mirrors the main app's MAX_LICENSING_FEE (src/shared/constants/... = 100). Keep in sync.
export const MAX_LICENSING_FEE = 100;

export type FeeRatio = { buzz: number; images: number };

// The image-count denominators offered in the UI (a select, not a free input). Every stored fee maps onto one
// of these — see feeToRatio, which is driven by this list, so adding a value here (e.g. 20, 50) is all it takes.
// Keep it sorted ascending, and keep 100 (the finest at the 0.01 column precision) so every fee stays exactly
// representable. DEFAULT_FEE_IMAGES seeds new/off inputs (and the bulk editor's default).
export const FEE_IMAGE_OPTIONS = [1, 10, 20, 50, 100] as const;
export const DEFAULT_FEE_IMAGES = 10;

// Stored per-image fee → a whole-number "buzz per images" pair whose denominator is one of FEE_IMAGE_OPTIONS.
// Integer-hundredths math (the column is 0.01 precision) stays float-safe; pick the smallest offered denominator
// that keeps buzz whole: 1 → {1,1}, 0.1 → {1,10}, 0.5 → {5,10}, 0.05 → {1,20}, 0.01 → {1,100}. `null`/0 → off.
export function feeToRatio(perImage: number | null): FeeRatio {
  if (perImage == null || perImage <= 0) return { buzz: 0, images: DEFAULT_FEE_IMAGES };
  const cents = Math.round(perImage * 100);
  for (const images of FEE_IMAGE_OPTIONS) {
    if ((cents * images) % 100 === 0) return { buzz: (cents * images) / 100, images };
  }
  // Unreachable while 100 ∈ FEE_IMAGE_OPTIONS (cents*100 % 100 === 0 always); guards a mislisted set.
  const images = FEE_IMAGE_OPTIONS[FEE_IMAGE_OPTIONS.length - 1];
  return { buzz: Math.round((cents * images) / 100), images };
}

// The "N ⚡ per M images" → per-image conversion + validation lives in the backend zod schema
// (licensingFeeRatioSchema in $lib/server/monetization/licensing-fee). This module stays display-only + shared.

// Read-only label for a stored fee. "1 ⚡ / image", "1 ⚡ / 10 images", or "Off".
export function formatFeeRatio(perImage: number | null): string {
  if (perImage == null || perImage <= 0) return 'Off';
  const { buzz, images } = feeToRatio(perImage);
  return images === 1 ? `${buzz} ⚡ / image` : `${buzz} ⚡ / ${images} images`;
}
