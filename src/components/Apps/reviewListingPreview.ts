/**
 * App Blocks mod review — build a store-preview view-model (`ListingCard` +
 * `ListingDetail`) for an UNAPPROVED listing from the data the moderator review
 * surface already has client-side. Pure + React-free so the mapping is unit-tested
 * in the node project (the browser suites are report-only), mirroring
 * `appListingCardView` / `appListingDetailView`.
 *
 * ROLE — the graceful FALLBACK. The real preview media now comes from the mod-only
 * `appListings.getListingPreviewForReview` projection (the SHADOW listing's icon /
 * cover / screenshots + scalars, projected with the SAME image→CDN-URL derivation as
 * the public store detail). This builder is what the review section renders WHILE
 * that query is loading, if it errors, or when the row has no backing listing id: a
 * placeholder-art LAYOUT preview from the row's already-loaded fields (name, category,
 * content-rating, creator chip, kind-aware framing) — so the surface never blanks or
 * crashes. The row carries no CDN image `url` / tagline / description, so those fall
 * to the store components' built-in placeholders. A caller that already HAS resolved
 * image URLs may still pass them via `images` and they flow straight through.
 */

import type { OffsitePendingRow } from '~/components/Apps/OffsiteReviewQueue';
import type {
  ListingCard,
  ListingCardKindData,
  ListingCreatorChip,
  ListingDetail,
  ListingDetailKindData,
  ListingGalleryScreenshot,
  ListingKind,
  ListingRecommendRollup,
} from '~/server/schema/blocks/app-listing-read.schema';

/**
 * Optionally-resolved image URLs + gallery for the preview. All fields optional so
 * the mod surface (which has no resolved URLs) can omit them → placeholder art. If a
 * future server projection supplies real CDN URLs, pass them here and they render.
 */
export type ReviewListingPreviewImages = {
  iconUrl?: string | null;
  coverUrl?: string | null;
  screenshots?: ListingGalleryScreenshot[];
};

/** No-reviews-yet rollup — a shadow/unapproved listing has no reviews. */
const EMPTY_RECOMMEND: ListingRecommendRollup = {
  recommendedCount: 0,
  notRecommendedCount: 0,
  recommendPct: null,
};

/** The listing's store KIND: an on-site media revision is an on-site listing; an
 *  external-link/connect revision is off-site. Absent row kind → off-site (the
 *  backward-compatible default the review adapters already use). */
function listingKind(row: OffsitePendingRow): ListingKind {
  return row.kind === 'onsite' ? 'onsite' : 'offsite';
}

/** Submitter chip → the public creator chip shape (id/username/image only). */
function creatorChip(row: OffsitePendingRow): ListingCreatorChip | null {
  const s = row.submittedBy;
  return s ? { id: s.id, username: s.username, image: s.image } : null;
}

/** Shared scalar fields common to the card + detail preview shapes. */
function commonFields(row: OffsitePendingRow, images?: ReviewListingPreviewImages) {
  return {
    id: row.appListingId ?? row.id,
    slug: row.slug,
    kind: listingKind(row),
    name: row.appListing?.name ?? row.slug,
    category: row.appListing?.category ?? null,
    contentRating: row.appListing?.contentRating ?? null,
    iconUrl: images?.iconUrl ?? null,
    coverUrl: images?.coverUrl ?? null,
    creator: creatorChip(row),
    recommend: EMPTY_RECOMMEND,
    reviewCount: 0,
  };
}

function cardKindData(row: OffsitePendingRow): ListingCardKindData {
  if (listingKind(row) === 'onsite') {
    // Backing appBlockId isn't carried on the review row; hasPage/liveUrl are
    // unknown here (unused by the preview CTA, which is omitted). Safe placeholders.
    return { kind: 'onsite', appBlockId: null, hasPage: false, liveUrl: '' };
  }
  return {
    kind: 'offsite',
    externalUrl: row.appListing?.externalUrl ?? null,
  };
}

function detailKindData(row: OffsitePendingRow): ListingDetailKindData {
  if (listingKind(row) === 'onsite') {
    return { kind: 'onsite', appBlockId: null, hasPage: false, liveUrl: '' };
  }
  return {
    kind: 'offsite',
    externalUrl: row.appListing?.externalUrl ?? null,
    connectClientId: row.appListing?.connectClientId ?? null,
  };
}

/** Build the grid-CARD preview from the review row (+ optional resolved images). */
export function buildListingCardPreview(
  row: OffsitePendingRow,
  images?: ReviewListingPreviewImages
): ListingCard {
  return {
    ...commonFields(row, images),
    tagline: null,
    // 🔴 ALWAYS `false` HERE, for exactly the reason `sourceRepoUrl` is always null in the
    // sibling detail builder below: `OffsitePendingRow` carries no beta columns, so there
    // is nothing honest to report. `false` is also the SAFE direction — this builder can
    // only ever fail to show a beta badge, never invent one on a listing that is not in
    // beta. The REAL preview comes from `getListingPreviewForReview`, which projects the
    // actual listing row and does carry it.
    isBeta: false,
    // 🔴 ALWAYS `null` — AND NOT FOR THE REASON THIS COMMENT USED TO GIVE. The old
    // version said "a listing still in the review queue has not been openable by
    // anyone", which is FALSE: an `onsite` review row is a listing-MEDIA revision of a
    // first-class, already-approved, already-LIVE app (see `OffsitePendingRow.kind`),
    // which may have any number of real opens.
    //
    // 🔴 THIS IS A DELIBERATE OVERRIDE OF THE DTO'S RULE, NOT A DERIVATION FROM IT.
    // Read that plainly, because an earlier draft of this very comment claimed the
    // opposite and the claim was WIDER THAN THE DECISION IT RECORDED — which is how a
    // later change talks itself into breaking the public card.
    //
    // What the DTO actually says (`app-listing-read.schema.ts`, and imperatively at
    // `app-listing.service.ts`'s `cardOpenCount`): an ON-SITE listing with no metric
    // row is a genuine `0` — "no plays recorded yet" — and you must NOT over-null it.
    // `null` there means "structurally unmeasurable", a property of the KIND (an
    // off-site `target="_blank"` anchor nothing on-platform observes). This builder's
    // on-site input is exactly "on-site, no metric row", so the DTO's written rule
    // yields `0` here.
    //
    // We return `null` anyway. The reason is not a rule, it is a judgement about THIS
    // surface: `OffsitePendingRow` carries no `AppListingMetric` and this builder never
    // reads one, so unlike `cardOpenCount` it can never become right later — a `0` here
    // is wrong permanently, on a moderator screen, for an app that may have 40,000
    // plays. Operator call, 2026-09-06: truth over parity.
    //
    // 🔴 DO NOT GENERALISE THIS INTO A RULE. "A producer that cannot measure returns
    // `null`" is the phrasing that was here before, and it is dangerous: `cardOpenCount`
    // also cannot measure today (nothing writes `open_count` yet), so that sentence
    // licenses returning `null` for on-site rows on the PUBLIC `GET /api/v1/apps` card —
    // which is mutant M2 in this PR's matrix and precisely what the DTO's "do not
    // over-null" paragraph exists to forbid. The override is scoped to this builder.
    //
    // 🔴 THIS DELIBERATELY DIVERGES FROM `cardOpenCount`, which returns a NUMBER for an
    // on-site row — and the divergence is the point, not an oversight. That function
    // reads the rollup; this one cannot. An earlier round made the two agree on SHAPE
    // by returning `0` here, which bought kind-parity at the cost of showing a
    // moderator "0 plays" for an app with 40,000 — permanently, since this builder
    // never gains a metric row and `previewQuery` is `retry: false`, so one error
    // pins the fallback for that mount. Operator call, 2026-09-06: truth over parity.
    //
    // Consequence, accepted: the stat row can appear when `previewQuery` resolves to a
    // real number. A row that appears is recoverable; a wrong number that never
    // corrects itself is not.
    //
    // ⚠️ The sibling `installCount: 0` below is a false zero of the SAME class and is
    // deliberately left alone — out of scope here, and inert (`buildListingStatChips`
    // returns `[]` under `preview`). Do not cite it as precedent for reverting this.
    openCount: null,
    kindData: cardKindData(row),
  };
}

/** Build the store-DETAIL preview from the review row (+ optional resolved images). */
export function buildListingDetailPreview(
  row: OffsitePendingRow,
  images?: ReviewListingPreviewImages
): ListingDetail {
  return {
    ...commonFields(row, images),
    // serialId only feeds the comments thread, which the preview omits → 0.
    serialId: 0,
    tagline: null,
    // 🔴 ALWAYS NULL HERE, and that is a limitation this builder OWNS rather than
    // hides. This is the FALLBACK preview, built from the publish-request row —
    // `OffsitePendingRow` carries no `sourceRepoUrl`, so there is nothing honest to
    // put here. The REAL preview a moderator sees comes from
    // `getListingPreviewForReview`, which projects the actual listing row through
    // `projectListingDetail` and DOES carry it (guarded against the manual-apply
    // column). Widening this fallback would mean widening the review-row query, which
    // is a bigger change than the placeholder-art path warrants — but it does mean a
    // mod who only ever saw THIS builder's output would not see the source link, so:
    // if the fallback ever becomes the primary path, this must be revisited.
    sourceRepoUrl: null,
    // Same limitation, same reason, same safe direction as the card builder's `isBeta`.
    isBeta: false,
    betaMessage: null,
    description: null,
    // The mod REVIEW preview intentionally shows no collaborator byline: this row is
    // built from an in-review publish request, not from a live listing, so there is no
    // accepted-and-displayed set to read yet. An empty array is the honest answer, not
    // a placeholder.
    collaborators: [],
    // 🔴 A REQUIRED-FIELD STAND-IN, NOT AN UPDATE TIME — and nothing may render it.
    //
    // The row is a PUBLISH REQUEST, not a live listing, so there is no
    // `app_listings.updated_at` to read (which is what `ListingDetail.updatedAt` is
    // declared to mean). The field is non-optional on the DTO, so the submission time
    // goes in as the nearest available scalar, normalised to the same ISO string the
    // real projection emits so both producers agree on the field's TYPE.
    //
    // An earlier note here claimed the value was "unobserved in practice" because the
    // `preview` posture omits the header meta line. That was FALSE: the Details rail's
    // `updated` row rendered it, under the label "Updated", so a moderator was shown
    // the SUBMISSION date presented as the app's last update. Both surfaces now omit it
    // in preview — the meta line in `AppListingDetailBody`, the rail row in
    // `buildListingDetailRows` (rule 2 there) — and the seam between THIS builder and
    // that one is pinned in `__tests__/reviewListingPreview.test.ts`, so the claim is a
    // guarded one rather than a comment anybody has to take on trust.
    updatedAt: new Date(row.submittedAt).toISOString(),
    // ⚠️ "An unapproved listing has never been installable" — the reason this line used
    // to give — is FALSE for the same input the `openCount` note above refutes it for:
    // an `onsite` review row is a media revision of an already-approved, already-LIVE
    // app, which is installable and may have real installs. This is a false zero of the
    // same class, left in place deliberately: it is out of scope for the PR that noticed
    // it, and it is inert on both consumers — `buildListingStatChips` returns `[]` under
    // `preview`, and `buildListingDetailRows`' install row is `!opts.preview`-gated too.
    // Fix it with a reader, not speculatively; do not cite it as precedent for turning
    // the `openCount` override above back into a `0`.
    installCount: 0,
    screenshots: images?.screenshots ?? [],
    kindData: detailKindData(row),
  };
}
