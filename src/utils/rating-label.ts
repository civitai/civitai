import type { MantineColor } from '@mantine/core';

/**
 * The Steam-style WORD LABEL for a positive-review proportion — ONE ladder, in one
 * place, for every surface that renders one.
 *
 * It was written for `ModelVersionReview` and lived inside that component file as a
 * module-private function. The app-store listing detail now renders the same signal
 * (a "Reviews" row reading "Very Positive (340)"), and the alternative was a SECOND
 * ladder with its own thresholds — the shape that regenerates the same off-by-one at
 * every call site. So the ladder moved here and both surfaces consume it.
 *
 * 🔴 EXTRACTED VERBATIM. The redundancy in the last branch (`totalCount >= 500` is
 * already implied by the two tests above it) is preserved deliberately: this is a
 * MOVE, not a rewrite, so a reader diffing against the old `ModelVersionReview` sees
 * byte-identical logic and the model page's rendered labels cannot have changed.
 * `__tests__/rating-label.test.ts` pins every boundary and every count bucket.
 *
 * `__tests__/rating-label.test.ts` asserts TWO things, and the second exists because
 * the first was measurably not enough:
 *   - the IMPORTER LEDGER — the caller set exactly, failing when it grows or shrinks;
 *   - that NO file in `src/` embeds a ladder of its own without importing this one.
 *     An importer ledger is structurally blind to a COPY (not importing is what a copy
 *     does), and a drifted copy planted in `components/Apps/` passed all 49 tests. The
 *     second scan looks for this ladder's OUTPUT ALPHABET in the source text instead.
 *
 * 🔴 DECIDED, NOT PENDING: `pages/3d-models/[id]/[[...slug]].tsx` keeps its own
 * `sentimentLabel` ladder — a DELIBERATE divergence, not a consolidation still owed.
 * The follow-up that was recorded here was worked and closed with "leave it separate";
 * the reasoning, and the measurement it rests on, live beside the allowlist entry in
 * `__tests__/rating-label.test.ts`. The short version: the two ladders disagree only at
 * the EXTREMES, and they disagree there because this one withholds its strongest words
 * until 500 reviews — a threshold a 3D model does not reach. Folding them together
 * would change verdicts on a live page at exactly the review counts that page sees.
 */
export type RatingLabel = {
  /** Display copy, e.g. `Very Positive`. Rendered `tt="capitalize"` by both callers. */
  label: string;
  /** Mantine colour token for the label text. */
  color: MantineColor;
};

/**
 * @param positiveRating up / (up + down), in [0,1]. Callers with zero reviews must
 *   short-circuit BEFORE calling this — a 0-review listing has no rating, and this
 *   would score it `Mixed` rather than "no reviews yet".
 * @param totalCount up + down. Widens the verdict at 10 / 50 / 500.
 */
export function getRatingLabel({
  positiveRating,
  totalCount,
}: {
  positiveRating: number;
  totalCount: number;
}): RatingLabel {
  if (positiveRating < 0.2) {
    if (totalCount < 10) return { label: 'Mixed', color: 'yellow' };
    else if (totalCount < 50) return { label: 'Negative', color: 'red' };
    else if (totalCount < 500) return { label: 'Very Negative', color: 'red' };
    else return { label: 'Overwhelmingly negative', color: 'red' };
  } else if (positiveRating < 0.4) {
    return { label: 'Mostly negative', color: 'orange' };
  } else if (positiveRating < 0.7) {
    return { label: 'Mixed', color: 'yellow' };
  } else if (positiveRating < 0.8) {
    return { label: 'Mostly Positive', color: 'lime' };
  } else {
    if (totalCount < 50) return { label: 'Positive', color: 'green' };
    else if (totalCount < 500) return { label: 'Very Positive', color: 'green' };
    else if (totalCount >= 500 && positiveRating < 0.95)
      return { label: 'Very Positive', color: 'green' };
    else return { label: 'Overwhelmingly Positive', color: 'green' };
  }
}
