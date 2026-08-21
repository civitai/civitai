import { Prisma } from '@prisma/client';

/**
 * The host image behind a placement, as every placement surface reads it.
 *
 * Shared because it is a rule, not a shape: the fields are what `toQueueImage`
 * needs to decide whether this domain may be sent the asset at all, and a
 * surface selecting fewer would silently hand the mask a `nsfwLevel` of
 * `undefined`.
 */
export const placementImageSelect = Prisma.validator<Prisma.ImageSelect>()({
  id: true,
  url: true,
  name: true,
  width: true,
  height: true,
  type: true,
  metadata: true,
  nsfwLevel: true,
});

/**
 * Whether a host image may be shown at all, independent of who is looking.
 *
 * 🔴 ONE COPY, BECAUSE A DIVERGENCE IS A DISCLOSURE. Every placement surface
 * shows an image its viewer did not upload, and the next exclusion added here
 * has to reach all of them. Added to the queue and not to the sticker book, it
 * would mean the book publishes on a public profile exactly the image the queue
 * was careful to withhold.
 *
 * A function, not a constant, because `publishedAt` is compared against **now**:
 * a scheduled post carries a non-null future `publishedAt`, so `{ not: null }`
 * served it ahead of its own publish time. A module-level constant would freeze
 * that comparison at import.
 *
 * `needsReview` and `acceptableMinor` are the two the feeds test that this did
 * not. Neither is implied by `ingestion`: a moderator flag leaves `ingestion` at
 * `Scanned`, so an image withheld from browse everywhere else on the site was
 * being returned in full — url included — to anyone who could see a placement
 * pointing at it.
 *
 * Not a browsing-level rule: levels are the viewer's and the domain's, applied
 * per request by `toQueueImage`.
 */
export const publishedPlacementImageWhere = (): Prisma.ImageWhereInput => ({
  post: { publishedAt: { not: null, lte: new Date() } },
  ingestion: 'Scanned',
  tosViolation: false,
  minor: false,
  poi: false,
  needsReview: null,
  acceptableMinor: false,
});
