import { Prisma } from '@prisma/client';
import { shownReviewSql } from '~/server/services/creator-service-deal-review-publish';
import { getBlockedPairIds } from '~/server/services/user-preferences.service';

/**
 * A review image's level, with `i` the image and `d` its deal: the deal's when that is higher, so
 * an X deal's image that scanned PG is still X. Every place a review image is shown rates it by this.
 */
export const reviewImageLevelSql = Prisma.sql`GREATEST(i."nsfwLevel", d."maxNsfwLevel")`;

/**
 * True in SQL when a review image may be shown at `levels` (the viewer's levels, already limited to
 * what the domain serves), with `i` the image, `r` its review and `d` the deal.
 */
export const reviewImageVisibleSql = (
  levels: number,
  { includeHidden = false } = {}
) => Prisma.sql`(
  (${includeHidden} OR r."hiddenAt" IS NULL) AND i."ingestion" = 'Scanned'::"ImageIngestionStatus" AND NOT i."tosViolation"
  AND i."needsReview" IS NULL AND NOT i."poi" AND NOT i."minor"
  AND i."nsfwLevel" BETWEEN 1 AND d."maxNsfwLevel"
  AND (${reviewImageLevelSql} & ${levels}::int) <> 0
  AND EXISTS (SELECT 1 FROM "ServiceOffering" o WHERE o."id" = d."offeringId" AND o."allowReviewWork")
)`;

/**
 * Whether a block either way between the viewer and a review image's buyer or seller hides it from
 * the viewer, as on the review. Moderators and the buyer always see it; so does a signed-out viewer.
 */
export async function isReviewImageBlockedForViewer({
  viewerId,
  buyerId,
  sellerId,
  isModerator,
}: {
  viewerId?: number;
  buyerId: number;
  sellerId: number;
  isModerator?: boolean;
}) {
  if (!viewerId || isModerator || viewerId === buyerId) return false;
  const blockedPair = await getBlockedPairIds(viewerId);
  return blockedPair.includes(buyerId) || blockedPair.includes(sellerId);
}

/**
 * A LATERAL subquery naming the review and deal image `i` is attached to, and its review level:
 * one row for a review image, none otherwise (an image is on at most one review).
 */
export const reviewOfImageSql = Prisma.sql`(
  SELECT r."id" AS "reviewId", d."id" AS "dealId", d."sellerId", ${reviewImageLevelSql} AS "level"
  FROM "ServiceDealReviewImage" ri
  JOIN "ServiceDealReview" r ON r."id" = ri."reviewId"
  JOIN "ServiceDeal" d ON d."id" = r."dealId"
  WHERE ri."imageId" = i."id"
)`;

/**
 * True in SQL when image `i` is attached to no service review. A review image is the seller's work:
 * it is viewed and reported, never collected, reacted to, commented on, remixed or made a cover.
 */
export const notReviewImageSql = Prisma.sql`NOT EXISTS (
  SELECT 1 FROM "ServiceDealReviewImage" ri WHERE ri."imageId" = i."id"
)`;

/**
 * True in SQL when image `i` is shown on its review at `levels`: the offering page's rule for the
 * review (`shownReviewSql`) and for its images (`reviewImageVisibleSql`).
 */
export const shownReviewImageSql = (levels: number) => Prisma.sql`EXISTS (
  SELECT 1 FROM "ServiceDealReviewImage" ri
  JOIN "ServiceDealReview" r ON r."id" = ri."reviewId"
  JOIN "ServiceDeal" d ON d."id" = r."dealId"
  JOIN "User" u ON u."id" = r."buyerId"
  WHERE ri."imageId" = i."id" AND r."buyerId" = i."userId"
    AND ${shownReviewSql} AND ${reviewImageVisibleSql(levels)}
)`;
