import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { SERVICE_PRICE_MIN } from '~/shared/constants/creator-service.constants';

type Db = Pick<Prisma.TransactionClient, '$executeRaw' | '$queryRaw'>;

/**
 * Whether a review may be shown, with `r` the review and `d` its deal: its comment passed its check,
 * no moderator hid it, and either the deal has settled or the buyer was happy and the deal is not
 * held for the moderators (a final that failed its scan holds a deal after a happy review). A happy
 * review of a deal refunded on dispute never shows.
 */
export const reviewPublic = Prisma.sql`(
  r."scanStatus" = 'Scanned'::"ServiceOfferingIngestionStatus" AND r."hiddenAt" IS NULL
  AND (d."settledAt" IS NOT NULL
    OR (r."verdict" = 'Happy'::"ServiceDealReviewVerdict" AND d."status" <> 'Disputed'::"ServiceDealStatus"))
  -- A happy review of a deal refunded on dispute is never shown or counted: the seller was not paid.
  AND NOT (r."verdict" = 'Happy'::"ServiceDealReviewVerdict"
    AND d."disputeResolution" IS NOT DISTINCT FROM 'Refund'::"ServiceDisputeResolution")
)`;

/** A buyer counts toward an offering's score only from an account a week old when they requested the deal. */
const BUYER_MIN_AGE = Prisma.sql`interval '7 days'`;

/**
 * An offering's happy and total counts from its published reviews, with `offeringId` naming the
 * offering in the surrounding statement. Each buyer counts once, by their latest published review,
 * and only for a deal at the minimum price or more, from an account a week old when it was requested
 * and not banned or deleted since (which counts from the next recount).
 */
export const offeringReviewTotals = (offeringId: Prisma.Sql) => Prisma.sql`(
  SELECT count(*) FILTER (WHERE c."verdict" = 'Happy')::int AS happy, count(*)::int AS total
  FROM (
    SELECT DISTINCT ON (r."buyerId") r."verdict"
    FROM "ServiceDealReview" r
    JOIN "ServiceDeal" d ON d."id" = r."dealId"
    JOIN "User" u ON u."id" = r."buyerId"
    WHERE r."offeringId" = ${offeringId} AND r."publishedAt" IS NOT NULL
      AND d."price" >= ${SERVICE_PRICE_MIN}::int
      AND d."requestedAt" - u."createdAt" >= ${BUYER_MIN_AGE}
      AND u."bannedAt" IS NULL AND u."deletedAt" IS NULL
    ORDER BY r."buyerId", r."publishedAt" DESC, r."id" DESC
  ) c
)`;

/** The score: the happy share once three buyers count, else -1. */
export const happySortKey = (happy: Prisma.Sql, total: Prisma.Sql) =>
  Prisma.sql`CASE WHEN ${total} >= 3 THEN ${happy}::float8 / ${total} ELSE -1 END`;

/** Raw SQL so the offering's `updatedAt`, which its own content check keys on, is left alone. */
async function recountOffering(tx: Db, offeringId: number) {
  await tx.$executeRaw`
    UPDATE "ServiceOffering" o
    SET "happyCount" = t.happy, "reviewCount" = t.total,
      "happySortKey" = ${happySortKey(Prisma.sql`t.happy`, Prisma.sql`t.total`)}
    FROM ${offeringReviewTotals(Prisma.sql`${offeringId}::int`)} t
    WHERE o."id" = ${offeringId}::int`;
}

/**
 * Publishes or unpublishes a deal's review to match `reviewPublic`, recounting its offering in the
 * same transaction only when the review's public state changed, so a repeat changes nothing.
 * Returns whether it changed.
 */
/**
 * Serialises a deal's review writes and its offering's recounts without locking the offering row its
 * seller edits. Every writer of a review row takes it before the row's own lock, so two writers
 * never wait on each other in opposite orders. Returns the offering, or null for a deal with no review.
 */
export async function lockDealReviewCounters(tx: Db, dealId: number) {
  const [review] = await tx.$queryRaw<{ offeringId: number }[]>`
    SELECT "offeringId" FROM "ServiceDealReview" WHERE "dealId" = ${dealId}::int`;
  if (!review) return null;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('service-offering-reviews'), ${review.offeringId}::int)`;
  return review.offeringId;
}

/**
 * Recounts an offering whose counters no longer match its rows: a buyer banned or deleted since
 * leaves the count with no review changing state. Returns whether it changed anything.
 */
export const recountOfferingReviews = (offeringId: number) =>
  dbWrite.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('service-offering-reviews'), ${offeringId}::int)`;
    await recountOffering(tx, offeringId);
  });

export async function syncDealReviewPublication(tx: Db, dealId: number) {
  const offeringId = await lockDealReviewCounters(tx, dealId);
  if (offeringId === null) return false;
  const changed = await tx.$executeRaw`
    UPDATE "ServiceDealReview" r
    SET "publishedAt" = CASE WHEN ${reviewPublic} THEN now() ELSE NULL END
    FROM "ServiceDeal" d
    WHERE r."dealId" = ${dealId}::int AND d."id" = r."dealId"
      AND (r."publishedAt" IS NULL) = ${reviewPublic}`;
  if (changed) await recountOffering(tx, offeringId);
  return changed > 0;
}

/** {@link syncDealReviewPublication} in a transaction of its own, for a review whose text or verdict moved. */
export const syncReviewPublication = (reviewId: number) =>
  dbWrite.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<{ dealId: number }[]>`
      SELECT "dealId" FROM "ServiceDealReview" WHERE "id" = ${reviewId}::int`;
    return row ? syncDealReviewPublication(tx, row.dealId) : false;
  });
