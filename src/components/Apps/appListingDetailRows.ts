/**
 * App Store Listings — the DETAILS ACCORDION row model (pure, React-free).
 *
 * The listing detail's right rail carries the model detail page's "Details" accordion:
 * a `.detailsPanel` of label/value rows (`ModelVersionDetails.module.scss`'s
 * `.detailRow` / `.detailLabel`). This module decides WHICH rows exist, in WHAT order,
 * and with WHAT values — so the correctness gate lives in the node `unit`
 * project rather than in the browser suite.
 *
 * Two rules the renderer must not re-implement:
 *   1. A row whose underlying field is null/absent is OMITTED. A "Rating: —" row is
 *      noise; an absent row is the honest signal.
 *   2. In `preview` posture (the moderator listing-media review, rendering an
 *      UNAPPROVED shadow listing) the REVIEWS, PLAYS and UPDATED rows are omitted.
 *      One rule, three fields — every one of them is a number or a date the posture
 *      cannot supply honestly:
 *        - REVIEWS: a shadow listing has no review rows at all, so its rollup is
 *          structurally 0/0. "No reviews yet" there reads as a fact about the APP
 *          rather than about the POSTURE.
 *        - PLAYS: the preview has no metric rollup to read (this row was INSTALLS,
 *          widened into the rule for the same reason). `buildListingStatChips` already
 *          returns NO chips in preview precisely so a zero cannot be read as a
 *          measurement.
 *        - UPDATED: the date a preview carries is NOT `app_listings.updated_at`.
 *          `buildListingDetailPreview` has no such field to read and substitutes the
 *          publish request's SUBMISSION time, so the row labelled "Updated" showed a
 *          moderator the moment the app was submitted. `AppListingDetailBody` already
 *          omits its header META LINE in preview for exactly this reason; the rail row
 *          rendered the same value under the same label two inches lower. The review
 *          surface prints the submission time itself, twice, correctly labelled.
 *      🔴 THE RULE IS "a number or date the posture cannot supply honestly", NOT "every
 *      row a preview does not need". The SOURCE row is deliberately NOT in that list: a
 *      shadow carries `sourceRepoUrl` verbatim and approving PUBLISHES it, so hiding it
 *      from the moderator would be hiding the very thing under review.
 *
 * The REVIEWS row's word label comes from the SHARED ladder (`~/utils/rating-label`),
 * the same one the model version page renders — not a second copy with its own
 * thresholds. See that module's header.
 */

import {
  LISTING_KIND_APP_LABELS,
  LISTING_FACET_LABELS,
  LISTING_REVIEWS_ANCHOR_ID,
  STANDALONE_KIND_LABEL,
} from '~/components/Apps/listingKindLabels';
import { getRatingLabel } from '~/utils/rating-label';
import { getRecommendLabel, listingUsageStat } from '~/components/Apps/appListingCardView';
import { marketplaceCategoryLabel } from '~/server/services/blocks/marketplace-categories.constants';
import {
  offsiteContentRatingColor,
  offsiteContentRatingLabel,
} from '~/shared/constants/browsingLevel.constants';
import { appsStoreCategoryHref } from '~/components/Apps/appsStoreQueryParams';
import type { ListingDetail } from '~/server/schema/blocks/app-listing-read.schema';

/** The `rel` of the Support row's outbound, author-chosen, any-host link. */
export const SUPPORT_LINK_REL = 'noopener noreferrer nofollow ugc';

/** A single label/value row of the Details panel. */
export type ListingDetailRow = {
  /** Stable key — also the row's `data-listing-detail-row` attribute in the DOM. */
  key:
    | 'kind'
    | 'category'
    | 'rating'
    | 'reviews'
    | 'plays'
    | 'installs'
    | 'updated'
    | 'source'
    | 'support';
  /** Dimmed left-hand label. */
  label: string;
  /** Right-hand display value. */
  value: string;
  /**
   * When set, the row's value renders as an ANCHOR to this URL rather than as plain
   * text. Only the `source` row sets it.
   *
   * 🔴 THE RENDERER MUST EMIT `target="_blank"` + `rel="noopener noreferrer"` for it.
   * `noopener` is the load-bearing half — without it the opened page gets a live
   * `window.opener` handle to this tab and can navigate it anywhere (reverse
   * tabnabbing, i.e. replacing the store page the user will come back to with a
   * look-alike). `noreferrer` additionally withholds the referrer. The value here is
   * already host-allowlisted and normalised server-side by `validateRepositoryUrl`, so
   * this is defence in depth on a link we already constrain, not the only control.
   */
  href?: string;
  /**
   * The `rel` for an {@link href} row, when it must say MORE than `noopener noreferrer`. Only
   * the `support` row sets it, to `noopener noreferrer nofollow ugc`: its destination is ANY
   * host the author chose (the source link is host-allowlisted), so the store neither vouches
   * for it (`nofollow`) nor presents it as its own (`ugc`). It always includes `noopener`.
   */
  rel?: string;
  /**
   * When set, the row's value renders as a SAME-PAGE fragment link to this element id.
   * Only the `reviews` row sets it, and only when there is something to jump to.
   *
   * 🔴 DELIBERATELY A SEPARATE FIELD FROM {@link href}, NOT A FRAGMENT SQUEEZED INTO IT.
   * `href`'s contract obliges the renderer to emit `target="_blank"` +
   * `rel="noopener noreferrer"`, which is correct for an outbound third-party URL and
   * WRONG here — it would open this page's own reviews section in a new tab. Two
   * different link kinds with two different security postures do not share one field;
   * merging them is how the `noopener` requirement quietly stops applying to the case
   * that needs it.
   *
   * 🔴 The id must be `LISTING_REVIEWS_ANCHOR_ID`, the same constant the section
   * renders — a fragment link to an id nothing renders fails SILENTLY.
   */
  anchorId?: string;
  /**
   * When set, the row's value renders as a SAME-SITE link to this store URL — the `/apps`
   * grid filtered to the listing's category. Only the `category` row sets it, and only
   * outside `preview` (the moderator review renders this panel inside a review surface,
   * where a link would navigate the reviewer away from the decision they are making).
   *
   * A THIRD link field rather than a reuse of {@link href} or {@link anchorId}, for the
   * reason `anchorId` gives: `href` obliges `target="_blank"` + `noopener` (right for an
   * outbound third-party URL, wrong for our own store), and `anchorId` is a fragment on
   * this page. A same-site navigation is neither.
   */
  storeHref?: string;
  /**
   * When set, the value renders as a coloured PILL in this Mantine colour instead of as
   * text. Only the `rating` row sets it, from `offsiteContentRatingColor` — the site's
   * existing browsing-level colours, not a palette of this panel's own.
   */
  pillColor?: string;
  /**
   * Mantine colour token for the value, when the value carries a verdict. Only the
   * `reviews` row sets it (the rating ladder's colour); everything else renders in the
   * default text colour.
   */
  color?: string;
};

/**
 * Human label for the store kind. Mirrors `getListingBadge`'s wording — and now
 * actually does: off-site used to fork here into "Connect app" / "Off-site link"
 * while the badge said "Connect app" / "Off-site", so the two surfaces disagreed
 * about the SAME listing. One kind, one word, the same word the store's kind
 * filter uses.
 */
function kindLabel(detail: Pick<ListingDetail, 'kindData'>): string {
  return detail.kindData.kind === 'onsite' ? LISTING_KIND_APP_LABELS.onsite : STANDALONE_KIND_LABEL;
}

/**
 * Build the ordered Details rows for a listing.
 *
 * @param opts.preview read-only moderator posture — omits the reviews, plays and
 *   updated rows (rule 2).
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
    | 'openCount'
    | 'installCount'
    | 'updatedAt'
  > &
    Partial<Pick<ListingDetail, 'sourceRepoUrl' | 'issueTrackerUrl'>>,
  opts: { preview?: boolean; formatDate: (iso: string) => string }
): ListingDetailRow[] {
  const rows: ListingDetailRow[] = [];

  // `key` stays `'kind'` — it is the stable row identity the tests and any consumer
  // select on. Only the human LABEL is single-sourced, so the detail rail and the
  // store filter cannot drift apart again (they said "Kind" and "Type").
  rows.push({ key: 'kind', label: LISTING_FACET_LABELS.kind, value: kindLabel(detail) });

  // 🔴 BOTH VALUES GO THROUGH THEIR DISPLAY-LABEL MAP. These two rows shipped
  // rendering the RAW stored enum — a tester read "utility" and "pg13" in the store
  // preview — while the card chip, the filter buttons and both mod selectors were
  // already mapping the same column one component over. Each helper keeps the raw
  // value as its fallback, so an unknown/legacy rating or a category added after
  // this client shipped degrades to the stored string rather than to a blank row.
  if (detail.category) {
    // A link only for a category the store can actually filter by — see
    // `appsStoreCategoryHref` — and never in preview (see `storeHref`).
    const storeHref = opts.preview ? null : appsStoreCategoryHref(detail.category);
    rows.push({
      key: 'category',
      label: 'Category',
      value: marketplaceCategoryLabel(detail.category),
      ...(storeHref ? { storeHref } : {}),
    });
  }
  if (detail.contentRating) {
    rows.push({
      key: 'rating',
      label: 'Rating',
      value: offsiteContentRatingLabel(detail.contentRating),
      pillColor: offsiteContentRatingColor(detail.contentRating),
    });
  }

  // SOURCE — the app's public source repository, when the author declared one.
  //
  // 🔴 PRESENT IN `preview`, unlike reviews / plays / updated, and that is rule 2
  // applied rather than ignored. Rule 2 omits a row when the PREVIEW POSTURE cannot
  // supply the value honestly: a shadow listing structurally has no reviews and no
  // metric rollup, and the date a preview carries is the submission time wearing an
  // "Updated" label. None of that is true here — the source link is a scalar the
  // shadow carries verbatim and the one `applyApprovedRevision` will publish, so
  // showing it to the moderator is the entire point of a review preview.
  //
  // 🔴 RUNTIME-GUARDED on the type, like `openCount`/`updatedAt` below and for the
  // same MEASURED reason: not every producer of a `ListingDetail`-shaped object goes
  // through `projectListingDetail` (the moderator combined-review surface builds one
  // through a cast), so a required TYPE is not a runtime guarantee. Absent, a
  // non-string, or empty ⇒ omit the row entirely — never a "Source: —".
  if (typeof detail.sourceRepoUrl === 'string' && detail.sourceRepoUrl.length > 0) {
    rows.push({
      key: 'source',
      label: 'Source',
      // Displayed WITHOUT the scheme (`github.com/owner/repo`): the rail is narrow, and
      // every accepted value is https by construction, so the prefix is eight columns
      // of no information. The `href` keeps the full absolute URL — stripping it there
      // would produce a relative link to a path on civitai.com.
      value: detail.sourceRepoUrl.replace(/^https:\/\//, ''),
      href: detail.sourceRepoUrl,
    });
  }

  // SUPPORT — where to report a problem (the issue tracker), right after Source. Present in
  // `preview` for the reason Source is: the shadow carries it and approving publishes it.
  // Runtime-guarded on the type for the same cast-producer reason.
  if (typeof detail.issueTrackerUrl === 'string' && detail.issueTrackerUrl.length > 0) {
    rows.push({
      key: 'support',
      label: 'Support',
      value: detail.issueTrackerUrl.replace(/^https:\/\//, '').replace(/\/$/, ''),
      href: detail.issueTrackerUrl,
      rel: SUPPORT_LINK_REL,
    });
  }

  if (!opts.preview) {
    const { recommendPct } = detail.recommend;
    if (detail.reviewCount === 0) {
      // Matches `getRecommendLabel`'s zero case. 🔴 The ladder is NOT called here: with
      // zero reviews `positiveRating` is 0, which the ladder scores `Mixed` — a verdict
      // about an app nobody has reviewed.
      // No `href` in the zero-review case: there is a section to jump to, but nothing
      // in it, so a link would move the viewer to an empty heading. The link is an
      // affordance for content that exists.
      rows.push({ key: 'reviews', label: 'Reviews', value: 'No reviews yet' });
    } else if (recommendPct == null) {
      // Reviews exist, but the server withheld the percentage (too few for one to mean
      // anything — `recommendRollup` owns the number). The counts, and no ladder verdict:
      // one positive review must not read "Positive (1)". No colour, since there is no
      // verdict; the link stays, because there are reviews to jump to.
      rows.push({
        key: 'reviews',
        label: 'Reviews',
        value: getRecommendLabel(detail.recommend, detail.reviewCount),
        anchorId: LISTING_REVIEWS_ANCHOR_ID,
      });
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
        // 🔴 Only with reviews — the zero-review row above deliberately omits it.
        // No `preview` guard is needed HERE because the whole block is already inside
        // `if (!opts.preview)`. That matters: the reviews SECTION is not rendered in
        // the preview posture, so a link emitted there would point at an id that does
        // not exist on the page — and a dead fragment link fails silently. The
        // existing row-level gate is what keeps that from happening; do not move this
        // row out from under it without moving the link too.
        anchorId: LISTING_REVIEWS_ANCHOR_ID,
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
  //
  // USAGE — "Plays" for an on-site listing (the store card's number), "Installs" for an
  // off-site one, which has no play count. `listingUsageStat` is the one rule, shared with
  // the header chip; a zero or a cast producer's `undefined` shows no row rather than
  // throwing.
  //
  // 🔴 …AND OMITTED WHOLESALE IN `preview` (rule 2): a preview has no metric rollup, so
  // any number there is a fact about the POSTURE, not about the app — the same reasoning
  // that makes `buildListingStatChips` return no chips at all in preview.
  const usage = opts.preview ? null : listingUsageStat(detail);
  if (usage) {
    rows.push({ key: usage.key, label: usage.label, value: usage.count.toLocaleString() });
  }

  // 🔴 OMITTED IN `preview` (rule 2): a preview's `updatedAt` is not the listing row's
  // `updated_at` — the fallback builder substitutes the publish request's submission
  // time — so this row labelled a submission date "Updated". The body already omits its
  // header meta line in preview for the same reason.
  if (!opts.preview && detail.updatedAt) {
    rows.push({ key: 'updated', label: 'Updated', value: opts.formatDate(detail.updatedAt) });
  }

  return rows;
}
