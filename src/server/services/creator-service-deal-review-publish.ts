import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { SERVICE_PRICE_MIN } from '~/shared/constants/creator-service.constants';

type Db = Pick<Prisma.TransactionClient, '$executeRaw' | '$queryRaw'>;

/**
 * Whether a review may be shown, with `r` the review and `d` its deal: its comment passed its check,
 * no moderator hid it, and either the deal has settled or the buyer was happy and the deal is not
 * held for the moderators (a final that failed its scan holds a deal after a happy review).
 */
const reviewPublic = Prisma.sql`(
  r."scanStatus" = 'Scanned'::"ServiceOfferingIngestionStatus" AND r."hiddenAt" IS NULL
  AND (d."settledAt" IS NOT NULL
    OR (r."verdict" = 'Happy'::"ServiceDealReviewVerdict" AND d."status" <> 'Disputed'::"ServiceDealStatus"))
)`;

/** A buyer counts toward an offering's score only from an account a week old when the deal was accepted. */
const BUYER_MIN_AGE = Prisma.sql`interval '7 days'`;

/**
 * Recounts an offering's reviews from its published rows. Each buyer counts once, by their latest
 * published review, and only for a deal at the minimum price or more. The score is the happy share
 * once three buyers count, else -1. Raw SQL so the offering's `updatedAt`, which its own content
 * check keys on, is left alone.
 */
async function recountOffering(tx: Db, offeringId: number) {
  await tx.$executeRaw`
    WITH counted AS (
      SELECT DISTINCT ON (r."buyerId") r."verdict"
      FROM "ServiceDealReview" r
      JOIN "ServiceDeal" d ON d."id" = r."dealId"
      JOIN "User" u ON u."id" = r."buyerId"
      WHERE r."offeringId" = ${offeringId}::int AND r."publishedAt" IS NOT NULL
        AND d."price" >= ${SERVICE_PRICE_MIN}::int
        AND d."acceptedAt" - u."createdAt" >= ${BUYER_MIN_AGE}
      ORDER BY r."buyerId", r."publishedAt" DESC, r."id" DESC
    ), totals AS (
      SELECT count(*) FILTER (WHERE "verdict" = 'Happy')::int AS happy, count(*)::int AS total
      FROM counted
    )
    UPDATE "ServiceOffering" o
    SET "happyCount" = t.happy, "reviewCount" = t.total,
      "happySortKey" = CASE WHEN t.total >= 3 THEN t.happy::float8 / t.total ELSE -1 END
    FROM totals t WHERE o."id" = ${offeringId}::int`;
}

/**
 * Publishes or unpublishes a deal's review to match `reviewPublic`, recounting its offering in the
 * same transaction only when the review's public state changed, so a repeat changes nothing.
 * Returns whether it changed.
 */
export async function syncDealReviewPublication(tx: Db, dealId: number) {
  const [review] = await tx.$queryRaw<{ offeringId: number }[]>`
    SELECT "offeringId" FROM "ServiceDealReview" WHERE "dealId" = ${dealId}::int`;
  if (!review) return false;
  // Serialises recounts of one offering without locking the offering row its seller edits.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('service-offering-reviews'), ${review.offeringId}::int)`;
  const changed = await tx.$executeRaw`
    UPDATE "ServiceDealReview" r
    SET "publishedAt" = CASE WHEN ${reviewPublic} THEN now() ELSE NULL END
    FROM "ServiceDeal" d
    WHERE r."dealId" = ${dealId}::int AND d."id" = r."dealId"
      AND (r."publishedAt" IS NULL) = ${reviewPublic}`;
  if (changed) await recountOffering(tx, review.offeringId);
  return changed > 0;
}

/** {@link syncDealReviewPublication} in a transaction of its own, for a review whose text or verdict moved. */
export const syncReviewPublication = (reviewId: number) =>
  dbWrite.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<{ dealId: number }[]>`
      SELECT "dealId" FROM "ServiceDealReview" WHERE "id" = ${reviewId}::int`;
    return row ? syncDealReviewPublication(tx, row.dealId) : false;
  });
