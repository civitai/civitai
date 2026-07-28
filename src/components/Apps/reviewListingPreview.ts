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
    subKind: row.appListing?.connectClientId != null ? 'connect' : 'external-link',
    externalUrl: row.appListing?.externalUrl ?? null,
  };
}

function detailKindData(row: OffsitePendingRow): ListingDetailKindData {
  if (listingKind(row) === 'onsite') {
    return { kind: 'onsite', appBlockId: null, hasPage: false, liveUrl: '' };
  }
  return {
    kind: 'offsite',
    subKind: row.appListing?.connectClientId != null ? 'connect' : 'external-link',
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
    description: null,
    screenshots: images?.screenshots ?? [],
    kindData: detailKindData(row),
  };
}
