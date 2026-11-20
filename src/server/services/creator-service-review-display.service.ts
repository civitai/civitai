import { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';
import { reviewImageVisibleSql } from '~/server/services/creator-service-deal-review-images';
import type { ServiceDealReviewVerdict } from '~/shared/utils/prisma/enums';

export const SERVICE_REVIEWS_PAGE_SIZE = 12;

/**
 * A review shown on its offering's page: published (which already carries the scan, hidden,
 * settled and refund rules), by a buyer still in good standing, on a deal whose rating the viewer's
 * levels allow. `r` the review, `d` its deal, `u` its buyer.
 */
const shownReviewSql = (offeringId: number, levels: number) => Prisma.sql`
  r."offeringId" = ${offeringId}::int AND r."publishedAt" IS NOT NULL
  AND u."bannedAt" IS NULL AND u."deletedAt" IS NULL
  AND (d."maxNsfwLevel" & ${levels}::int) <> 0`;

type ReviewImageRow = {
  reviewId: number;
  id: number;
  name: string | null;
  url: string;
  hash: string | null;
  width: number | null;
  height: number | null;
  type: string;
  metadata: Prisma.JsonValue;
  userId: number;
  /** Rated at the deal's level when that is higher, as everywhere a review image is shown. */
  nsfwLevel: number;
};

const reviewImageColumns = Prisma.sql`ri."reviewId", i."id", i."name", i."url", i."hash", i."width",
  i."height", i."type"::text AS "type", i."metadata", i."userId",
  GREATEST(i."nsfwLevel", d."maxNsfwLevel") AS "nsfwLevel"`;

/** Newest first, paged by review id. `levels`: the viewer's levels, already limited to the domain. */
export async function getServiceOfferingReviews({
  offeringId,
  levels,
  cursor,
  limit = SERVICE_REVIEWS_PAGE_SIZE,
}: {
  offeringId: number;
  levels: number;
  cursor?: number;
  limit?: number;
}) {
  const rows = await dbRead.$queryRaw<
    {
      id: number;
      buyerId: number;
      verdict: ServiceDealReviewVerdict;
      comment: string | null;
      publishedAt: Date;
      sellerReply: string | null;
      sellerReplyAt: Date | null;
    }[]
  >`
    SELECT r."id", r."buyerId", r."verdict", r."comment", r."publishedAt",
      CASE WHEN r."sellerReplyScanStatus"::text = 'Scanned' THEN r."sellerReply" END AS "sellerReply",
      CASE WHEN r."sellerReplyScanStatus"::text = 'Scanned' THEN r."sellerReplyAt" END AS "sellerReplyAt"
    FROM "ServiceDealReview" r
    JOIN "ServiceDeal" d ON d."id" = r."dealId"
    JOIN "User" u ON u."id" = r."buyerId"
    WHERE ${shownReviewSql(offeringId, levels)}
      ${
        cursor
          ? Prisma.sql`AND (r."publishedAt", r."id") <
              (SELECT c."publishedAt", c."id" FROM "ServiceDealReview" c WHERE c."id" = ${cursor}::int)`
          : Prisma.empty
      }
    ORDER BY r."publishedAt" DESC, r."id" DESC
    LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit);
  const images = page.length
    ? await dbRead.$queryRaw<ReviewImageRow[]>`
        SELECT ${reviewImageColumns}
        FROM "ServiceDealReviewImage" ri
        JOIN "Image" i ON i."id" = ri."imageId"
        JOIN "ServiceDealReview" r ON r."id" = ri."reviewId"
        JOIN "ServiceDeal" d ON d."id" = r."dealId"
        WHERE ri."reviewId" IN (${Prisma.join(page.map((row) => row.id))})
          AND ${reviewImageVisibleSql(levels)}
        ORDER BY i."id"`
    : [];
  return {
    items: page.map((row) => ({
      ...row,
      images: images.filter((image) => image.reviewId === row.id),
    })),
    nextCursor: rows.length > limit ? page[page.length - 1].id : undefined,
  };
}

/** The received-work strip: every shown image across the offering's shown reviews, newest review first. */
export async function getServiceOfferingReviewWork({
  offeringId,
  levels,
  cursor,
  limit = SERVICE_REVIEWS_PAGE_SIZE,
}: {
  offeringId: number;
  levels: number;
  /** The last image id of the previous page. */
  cursor?: number;
  limit?: number;
}) {
  const rows = await dbRead.$queryRaw<ReviewImageRow[]>`
    SELECT ${reviewImageColumns}
    FROM "ServiceDealReviewImage" ri
    JOIN "Image" i ON i."id" = ri."imageId"
    JOIN "ServiceDealReview" r ON r."id" = ri."reviewId"
    JOIN "ServiceDeal" d ON d."id" = r."dealId"
    JOIN "User" u ON u."id" = r."buyerId"
    WHERE ${shownReviewSql(offeringId, levels)} AND ${reviewImageVisibleSql(levels)}
      ${
        cursor
          ? Prisma.sql`AND (r."publishedAt", i."id") < (
              SELECT c."publishedAt", ci."imageId" FROM "ServiceDealReviewImage" ci
              JOIN "ServiceDealReview" c ON c."id" = ci."reviewId" WHERE ci."imageId" = ${cursor}::int)`
          : Prisma.empty
      }
    ORDER BY r."publishedAt" DESC, i."id" DESC
    LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit);
  return { items: page, nextCursor: rows.length > limit ? page[page.length - 1].id : undefined };
}
