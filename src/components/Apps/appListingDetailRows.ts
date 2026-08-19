/**
 * App Store Listings — the DETAILS ACCORDION row model (pure, React-free).
 *
 * The listing detail's right rail carries the model detail page's "Details" accordion:
 * a `.detailsPanel` of label/value rows (`ModelVersionDetails.module.scss`'s
 * `.detailRow` / `.detailLabel`). This module decides WHICH rows exist, in WHAT order,
 * and with WHAT values — so the correctness gate lives in the blocking node `unit`
 * project rather than in the report-only browser suite.
 *
 * Two rules the renderer must not re-implement:
 *   1. A row whose underlying field is null/absent is OMITTED. A "Rating: —" row is
 *      noise; an absent row is the honest signal.
 *   2. In `preview` posture (the moderator listing-media review, rendering an
 *      UNAPPROVED shadow listing) the REVIEWS row is omitted. A shadow listing has no
 *      review rows at all, so its rollup is structurally 0/0 and rendering "No reviews
 *      yet" there would read as a fact about the app rather than about the posture.
 *
 * The REVIEWS row's word label comes from the SHARED ladder (`~/utils/rating-label`),
 * the same one the model version page renders — not a second copy with its own
 * thresholds. See that module's header.
 */

import { getRatingLabel } from '~/utils/rating-label';
import type { ListingDetail } from '~/server/schema/blocks/app-listing-read.schema';

/** A single label/value row of the Details panel. */
export type ListingDetailRow = {
  /** Stable key — also the row's `data-listing-detail-row` attribute in the DOM. */
  key: 'kind' | 'category' | 'rating' | 'reviews' | 'installs' | 'updated';
  /** Dimmed left-hand label. */
  label: string;
  /** Right-hand display value. */
  value: string;
  /**
   * Mantine colour token for the value, when the value carries a verdict. Only the
   * `reviews` row sets it (the rating ladder's colour); everything else renders in the
   * default text colour.
   */
  color?: string;
};

/** Human label for the store kind + sub-kind. Mirrors `getListingBadge`'s wording. */
function kindLabel(detail: Pick<ListingDetail, 'kindData'>): string {
  if (detail.kindData.kind === 'onsite') return 'On-site app';
  return detail.kindData.subKind === 'connect' ? 'Connect app' : 'Off-site link';
}

/**
 * Build the ordered Details rows for a listing.
 *
 * @param opts.preview read-only moderator posture — omits the reviews row (rule 2).
 * @param opts.formatDate injected so this module stays pure and the test can pin the
 *   ORDER and OMISSION rules without depending on dayjs' locale or the host timezone.
 */
export function buildListingDetailRows(
  detail: Pick<
    ListingDetail,
    | 'kindData'
    | 'category'
    | 'contentRating'
    | 'recommend'
    | 'reviewCount'
    | 'installCount'
    | 'updatedAt'
  >,
  opts: { preview?: boolean; formatDate: (iso: string) => string }
): ListingDetailRow[] {
  const rows: ListingDetailRow[] = [];

  rows.push({ key: 'kind', label: 'Kind', value: kindLabel(detail) });

  if (detail.category) {
    rows.push({ key: 'category', label: 'Category', value: detail.category });
  }
  if (detail.contentRating) {
    rows.push({ key: 'rating', label: 'Rating', value: detail.contentRating });
  }

  if (!opts.preview) {
    const { recommendPct } = detail.recommend;
    if (recommendPct == null || detail.reviewCount === 0) {
      // Matches `getRecommendLabel`'s zero case. 🔴 The ladder is NOT called here: with
      // zero reviews `positiveRating` is 0, which the ladder scores `Mixed` — a verdict
      // about an app nobody has reviewed.
      rows.push({ key: 'reviews', label: 'Reviews', value: 'No reviews yet' });
    } else {
      const { label, color } = getRatingLabel({
        positiveRating: recommendPct,
        totalCount: detail.reviewCount,
      });
      rows.push({
        key: 'reviews',
        label: 'Reviews',
        value: `${label} (${detail.reviewCount.toLocaleString()})`,
        color: String(color),
      });
    }
  }

  // 🔴 GUARDED AT RUNTIME EVEN THOUGH BOTH FIELDS ARE DECLARED REQUIRED, and this is a
  // MEASURED defect rather than defensive habit — the same one
  // `ListingCollaboratorByline` already carries a note about. Not every producer of a
  // `ListingDetail`-shaped object goes through `projectListingDetail`: the moderator
  // combined-review surface builds one directly (through a cast), and the moment these
  // two fields were added, `undefined.toLocaleString()` threw inside this panel and
  // took the WHOLE review modal down with it — a crashing child unmounts its ancestors,
  // so the mod saw a blank `<body>`. Caught by the pre-existing
  // `CombinedReviewModal.browser.test.tsx`.
  //
  // A details row is DECORATION. It must never be able to blank the page it decorates,
  // and a required TYPE is not a runtime guarantee about a value that crossed a cast.
  // An absent field therefore takes the same path as a null `category`: omit the row.
  if (typeof detail.installCount === 'number') {
    rows.push({
      key: 'installs',
      label: 'Installs',
      value: detail.installCount.toLocaleString(),
    });
  }

  if (detail.updatedAt) {
    rows.push({ key: 'updated', label: 'Updated', value: opts.formatDate(detail.updatedAt) });
  }

  return rows;
}
