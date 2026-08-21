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
 * shows an image its viewer did not upload, and the next exclusion added here —
 * a new ingestion state, a `needsReview`, a takedown flag — has to reach all of
 * them. Added to the queue and not to the sticker book, it would mean the book
 * publishes on a public profile exactly the image the queue was careful to
 * withhold.
 *
 * Not a browsing-level rule: levels are the viewer's and the domain's, applied
 * per request by `toQueueImage`.
 */
export const publishedPlacementImageWhere = Prisma.validator<Prisma.ImageWhereInput>()({
  post: { publishedAt: { not: null } },
  ingestion: 'Scanned',
  tosViolation: false,
  minor: false,
  poi: false,
});
