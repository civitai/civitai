import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import {
  SERVICE_HAPPY_MIN_REVIEWS,
  SERVICE_PRICE_MIN,
} from '~/shared/constants/creator-service.constants';

/** The advisory-lock class for an offering's review writes and recounts. */
const REVIEW_LOCK_CLASS = 'service-offering-reviews';

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
  AND NOT (r."verdict" = 'Happy'::"ServiceDealReviewVerdict"
    AND d."disputeResolution" IS NOT DISTINCT FROM 'Refund'::"ServiceDisputeResolution")
)`;

const BUYER_MIN_AGE = Prisma.sql`interval '7 days'`;

/**
 * A published review by a buyer still in good standing, `r` the review and `u` its buyer: what the
 * offering page lists. The counters below add the counting bar (minimum price, account age, one
 * per buyer) on top, so a review can be listed without being counted.
 */
export const shownReviewSql = Prisma.sql`r."publishedAt" IS NOT NULL
  AND u."bannedAt" IS NULL AND u."deletedAt" IS NULL`;

/**
 * An offering's happy and total counts from its published reviews, with `offeringId` naming the
 * offering in the surrounding statement. Each buyer counts once, by their latest published review.
 * A ban or deletion counts from the next recount.
 */
export const offeringReviewTotals = (offeringId: Prisma.Sql) => Prisma.sql`(
  SELECT count(*) FILTER (WHERE c."verdict" = 'Happy')::int AS happy, count(*)::int AS total
  FROM (
    SELECT DISTINCT ON (r."buyerId") r."verdict"
    FROM "ServiceDealReview" r
    JOIN "ServiceDeal" d ON d."id" = r."dealId"
    JOIN "User" u ON u."id" = r."buyerId"
    WHERE r."offeringId" = ${offeringId} AND ${shownReviewSql}
      AND d."price" >= ${SERVICE_PRICE_MIN}::int
      AND d."requestedAt" - u."createdAt" >= ${BUYER_MIN_AGE}
    ORDER BY r."buyerId", r."publishedAt" DESC, r."id" DESC
  ) c
)`;

/** The happy share once enough buyers count, else -1 (never null, so the sort pages cleanly). */
export const happySortKey = (happy: Prisma.Sql, total: Prisma.Sql) =>
  Prisma.sql`CASE WHEN ${total} >= ${SERVICE_HAPPY_MIN_REVIEWS}::int THEN ${happy}::float8 / ${total} ELSE -1 END`;

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
 * Serialises a deal's review writes and its offering's recounts without locking the offering row its
 * seller edits. Every writer of a review row takes it before the row's own lock, so two writers
 * never wait on each other in opposite orders. Returns the offering, or null for a deal with no review.
 */
export async function lockDealReviewCounters(tx: Db, dealId: number) {
  const [review] = await tx.$queryRaw<{ offeringId: number }[]>`
    SELECT "offeringId" FROM "ServiceDealReview" WHERE "dealId" = ${dealId}::int`;
  if (!review) return null;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${REVIEW_LOCK_CLASS}), ${review.offeringId}::int)`;
  return review.offeringId;
}

/**
 * Recounts an offering whose counters no longer match its rows: a buyer banned or deleted since
 * leaves the count with no review changing state. Returns whether it changed anything.
 */
export const recountOfferingReviews = (offeringId: number) =>
  dbWrite.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${REVIEW_LOCK_CLASS}), ${offeringId}::int)`;
    await recountOffering(tx, offeringId);
  });

/**
 * Publishes or unpublishes a deal's review to match `reviewPublic`, recounting its offering in the
 * same transaction only when the review's public state changed, so a repeat changes nothing.
 * Returns whether it changed.
 */
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
