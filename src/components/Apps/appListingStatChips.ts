/**
 * App Store Listings — the header STAT CHIP model (pure, React-free).
 *
 * Sibling of `appListingDetailRows.ts`, and here for the same reason: the chips and
 * their hover-card copy are the only place the listing still renders the recommend
 * PERCENTAGE and the NOT-recommended count, and the browser `component` project that
 * renders them is **not run by CI**. A guard that lives only there is invisible to
 * everyone, so the decision itself is extracted and pinned in the blocking node `unit`
 * project. The component becomes a renderer of this list and decides nothing.
 *
 * 🔴 WHY THIS MODULE EXISTS AT ALL — two defects it was extracted to fix, both of which
 * were live on the branch and both of which a browser-only test would still not gate:
 *
 *   1. The hover message was passed as `recommendPct == null ? detail : undefined`,
 *      i.e. the percentage was supplied ONLY when there were no reviews to have a
 *      percentage of. `StatHoverCard` renders `message` INSTEAD of the numeric value,
 *      so with reviews present the dropdown fell through to `value.toLocaleString()` —
 *      the same number already printed on the chip face — and `"87% recommend (340)"`
 *      was unreachable. The message is now unconditional.
 *
 *      🔴 Note the fix is NOT flipping the condition to `!= null`. That renders a bare
 *      `"0"` for a listing with no reviews (the chip's own value), which is worse than
 *      the branch it replaces. Dropping the ternary is what makes BOTH postures right:
 *      the no-review case has its own honest copy.
 *
 *   2. `notRecommendedCount` was rendered NOWHERE. The pre-redesign body printed
 *      "N recommend · M don't"; the redesign dropped that line and nothing took it
 *      over, so the page lost the negative half of the rollup entirely. It is folded
 *      back into the recommend chip's hover message here — one hover, the whole
 *      rollup — rather than into a Details row, which would have put half the review
 *      aggregate in the rail and half in the header.
 *
 * 🔴 `preview` POSTURE. The moderator listing-media review renders this body over an
 * UNAPPROVED shadow listing, which structurally has no reviews and no installs — its
 * rollup is 0/0 because nobody could have reviewed it, not because nobody did. Both
 * chips are therefore omitted, and that omission is decided HERE (the component just
 * renders the list, and renders nothing for an empty one) so the RULE is covered by
 * the suite CI actually runs.
 *
 * 🔴 The component's WIRING is a SEPARATE, UNGATED claim. That `StatChips` hands this
 * function the real `preview` value is pinned only in the browser tier, which CI does
 * not run — mutating that call site leaves every node test green. Covering the rule
 * here does not cover the hand-off to it.
 */

import { getRecommendLabel } from '~/components/Apps/appListingCardView';
import type { ListingDetail } from '~/server/schema/blocks/app-listing-read.schema';

/** One header stat chip: an `IconBadge` face wrapped in a `StatHoverCard`. */
export type ListingStatChip = {
  /** Stable key — also the chip's `data-listing-stat` attribute in the DOM. */
  key: 'recommend' | 'installs';
  /** Hover-card TITLE. */
  label: string;
  /** The number printed on the chip face, and the hover card's `value` fallback. */
  value: number;
  /** Accessible name — the bare number on the face cannot supply one. */
  ariaLabel: string;
  /**
   * Hover-card body copy. When set, `StatHoverCard` renders THIS INSTEAD of the
   * numeric value — so a chip whose dropdown should just repeat its own number (the
   * installs chip) must leave it undefined rather than spell the number again.
   */
  message?: string;
};

type StatInput = Pick<ListingDetail, 'recommend' | 'reviewCount' | 'installCount'>;

/** True when the rollup carries no reviews at all — no percentage, no negative half. */
function hasNoReviews(detail: Pick<ListingDetail, 'recommend' | 'reviewCount'>): boolean {
  // Both conditions, matching `buildListingDetailRows`' reviews row: the two fields are
  // separate scalars off one rollup, and a `0/0` metric row can produce a pct without a
  // count.
  return detail.recommend.recommendPct == null || detail.reviewCount === 0;
}

/**
 * The recommend chip's hover copy — the ONLY surface that still renders the recommend
 * percentage and the not-recommended count.
 *
 * With reviews:  `87% recommend (340) · 44 don't`
 * Without:       `No reviews yet`
 *
 * The percentage half is delegated to `getRecommendLabel`, the same function the store
 * grid cards render, rather than re-rounded here — a second rounding is exactly the
 * shape that drifts by one at one call site.
 */
export function buildRecommendHoverMessage(
  detail: Pick<ListingDetail, 'recommend' | 'reviewCount'>
): string {
  // The zero copy is `getRecommendLabel`'s own (`recommendPct == null` → "No reviews
  // yet"), taken from it rather than restated as a second literal that can drift from
  // the store cards'. The `null` is forced because the OTHER zero shape — a non-null
  // pct with a zero count — must reach the same branch.
  if (hasNoReviews(detail))
    return getRecommendLabel({ ...detail.recommend, recommendPct: null }, detail.reviewCount);

  const positive = getRecommendLabel(detail.recommend, detail.reviewCount);
  const { notRecommendedCount } = detail.recommend;
  // 🔴 Runtime-guarded even though the field is declared REQUIRED, for the reason
  // `buildListingDetailRows` carries a note about: not every producer of a
  // `ListingDetail`-shaped object goes through `projectListingDetail`, and
  // `undefined.toLocaleString()` inside a header chip would unmount the whole page.
  // An absent negative half degrades to the positive half alone; it never throws.
  if (typeof notRecommendedCount !== 'number') return positive;
  return `${positive} · ${notRecommendedCount.toLocaleString()} don't`;
}

/**
 * Build the ordered header stat chips.
 *
 * @param opts.preview read-only moderator posture — yields NO chips (see the header).
 */
export function buildListingStatChips(
  detail: StatInput,
  opts: { preview?: boolean } = {}
): ListingStatChip[] {
  if (opts.preview) return [];

  const chips: ListingStatChip[] = [];

  const recommendedCount = detail.recommend.recommendedCount;
  chips.push({
    key: 'recommend',
    label: 'Recommendations',
    value: recommendedCount,
    ariaLabel: `${recommendedCount.toLocaleString()} recommendations`,
    // 🔴 UNCONDITIONAL. See defect (1) in the header — a ternary here is what made the
    // percentage unreachable on every listing that had one.
    message: buildRecommendHoverMessage(detail),
  });

  chips.push({
    key: 'installs',
    label: 'Installs',
    value: detail.installCount,
    ariaLabel: `${detail.installCount.toLocaleString()} installs`,
    // No message: the dropdown showing the full, un-abbreviated count IS the content.
  });

  return chips;
}
