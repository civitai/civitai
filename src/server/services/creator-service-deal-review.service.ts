import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import { transitionDeal } from '~/server/services/creator-service-deal.service';
import { syncDealReviewPublication } from '~/server/services/creator-service-deal-review-publish';
import { releaseDeal } from '~/server/services/creator-service-escrow.service';
import { scanServiceDealReviewText } from '~/server/services/service-deal-review-moderation.adapter';
import { csamQueueClearSql } from '~/server/services/text-scan/csam-hold-state';
import { SERVICE_DEAL_REVIEW_EDIT_MS } from '~/shared/constants/creator-services.constants';
import type { ServiceDealReviewVerdict } from '~/shared/utils/prisma/enums';

const ms = (value: number) => Prisma.sql`(${value}::int * interval '1 millisecond')`;

/** The check every writer of a review's comment or reply runs before saving it. */
export const assertReviewText = (text: string | null | undefined) =>
  throwOnBlockedUserContent(text, { surface: 'service-deal-review' });

const reviewsOff = () =>
  new TRPCError({ code: 'FORBIDDEN', message: 'Reviews are not available.' });

/** CONFLICT, so the card refetches on the code rather than on copy. */
const dealChanged = () =>
  new TRPCError({
    code: 'CONFLICT',
    message: 'This deal just changed. Refresh to see where it is.',
  });

/**
 * The review row, copied from the deal so its parties and offering are the deal's own. A comment
 * waits for its content check; none has nothing to check.
 */
const insertReview = async (
  tx: Prisma.TransactionClient,
  dealId: number,
  verdict: ServiceDealReviewVerdict,
  comment: string | null
) => {
  const [row] = await tx.$queryRaw<{ id: number }[]>`
    INSERT INTO "ServiceDealReview" ("dealId", "offeringId", "sellerId", "buyerId", "verdict",
      "comment", "scanStatus", "editableUntil", "updatedAt")
    SELECT d."id", d."offeringId", d."sellerId", d."buyerId", ${verdict}::"ServiceDealReviewVerdict",
      ${comment}::text,
      (CASE WHEN ${comment}::text IS NULL THEN 'Scanned' ELSE 'Pending' END)::"ServiceOfferingIngestionStatus",
      now() + ${ms(SERVICE_DEAL_REVIEW_EDIT_MS)}, now()
    FROM "ServiceDeal" d WHERE d."id" = ${dealId}::int
    RETURNING "id"`;
  return row.id;
};

/** After the review is committed: the comment is unshown until its check settles it. */
const scanComment = (reviewId: number, comment: string | null) =>
  comment ? scanServiceDealReviewText('ServiceDealReview', reviewId) : Promise.resolve();

/**
 * The buyer's review of a completed deal. Happy pays the seller now: the review and the moved
 * release time are written together or not at all, and the payout starts without being waited
 * on, the release sweep finishing it if this attempt fails. Not quite only records the review.
 */
export async function reviewServiceDeal({
  dealId,
  userId,
  verdict,
  comment,
  reviewFlag,
}: {
  dealId: number;
  userId: number;
  verdict: ServiceDealReviewVerdict;
  comment?: string | null;
  /** The buyer's live review flag, read per request, so turning it off stops new reviews. */
  reviewFlag: boolean;
}) {
  if (!reviewFlag) throw reviewsOff();
  const text = comment?.trim() || null;
  await assertReviewText(text);

  let reviewId: number | undefined;
  if (verdict === 'Happy') {
    const moved = await transitionDeal({
      dealId,
      from: ['Completed'],
      to: 'Completed',
      actorId: userId,
      event: 'ReviewedHappy',
      lock: true,
      where: Prisma.sql`"buyerId" = ${userId}::int AND "reviewEnabledAt" IS NOT NULL
        AND "settledAt" IS NULL AND "disputeOpenedAt" IS NULL AND "releaseAt" > now()
        AND NOT EXISTS (SELECT 1 FROM "ServiceDealReview" r WHERE r."dealId" = "ServiceDeal"."id")`,
      set: Prisma.sql`, "releaseAt" = now()`,
      then: async (tx) => {
        reviewId = await insertReview(tx, dealId, 'Happy', text);
        await syncDealReviewPublication(tx, dealId);
      },
    });
    if (!moved || reviewId === undefined) throw dealChanged();
    await scanComment(reviewId, text);
    // Not awaited: a slow Buzz call must not hold the buyer's click. The sweep is the fallback.
    void releaseDeal(dealId).catch((error) =>
      logToAxiom({
        name: 'creator-service-deal',
        type: 'error',
        message: 'release after a happy review failed; the sweep will retry',
        payload: { dealId },
        error: (error as Error)?.message,
      })
    );
    return { verdict };
  }

  const inserted = await dbWrite.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "ServiceDeal" WHERE "id" = ${dealId}::int FOR UPDATE`;
    const [eligible] = await tx.$queryRaw<{ id: number }[]>`
      SELECT d."id" FROM "ServiceDeal" d
      WHERE d."id" = ${dealId}::int AND d."buyerId" = ${userId}::int
        AND d."status" = 'Completed'::"ServiceDealStatus" AND d."reviewEnabledAt" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "ServiceDealReview" r WHERE r."dealId" = d."id")`;
    if (!eligible) return undefined;
    const id = await insertReview(tx, dealId, 'NotQuite', text);
    await syncDealReviewPublication(tx, dealId);
    return id;
  });
  if (inserted === undefined) throw dealChanged();
  await scanComment(inserted, text);
  return { verdict };
}

/**
 * The buyer's edit of their comment, within the edit window and while no moderator has hid the
 * review. The review is unshown until the new comment passes its check; a comment the csam queue
 * holds stays blocked whatever it is changed to. The verdict cannot change.
 */
export async function editServiceDealReview({
  dealId,
  userId,
  comment,
  reviewFlag,
}: {
  dealId: number;
  userId: number;
  comment?: string | null;
  reviewFlag: boolean;
}) {
  if (!reviewFlag) throw reviewsOff();
  const text = comment?.trim() || null;
  await assertReviewText(text);
  const reviewId = await dbWrite.$transaction(async (tx) => {
    const [review] = await tx.$queryRaw<{ id: number }[]>`
      SELECT "id" FROM "ServiceDealReview"
      WHERE "dealId" = ${dealId}::int AND "buyerId" = ${userId}::int
        AND "editableUntil" > now() AND "hiddenAt" IS NULL
      FOR UPDATE`;
    if (!review) return undefined;
    await tx.$executeRaw`
      UPDATE "ServiceDealReview" SET "comment" = ${text}::text, "scanWorkflowId" = NULL,
        "scanStatus" = (CASE
          WHEN "scanStatus" = 'Blocked' AND NOT ${csamQueueClearSql('ServiceDealReview', review.id)}
            THEN 'Blocked'
          WHEN ${text}::text IS NULL THEN 'Scanned' ELSE 'Pending' END)::"ServiceOfferingIngestionStatus",
        "updatedAt" = now()
      WHERE "id" = ${review.id}::int`;
    await syncDealReviewPublication(tx, dealId);
    return review.id;
  });
  if (reviewId === undefined) throw dealChanged();
  await scanComment(reviewId, text);
}

/** The seller's one reply to the buyer's review, shown under it once it passes its check. */
export async function replyToServiceDealReview({
  dealId,
  userId,
  reply,
  reviewFlag,
}: {
  dealId: number;
  userId: number;
  reply: string;
  reviewFlag: boolean;
}) {
  if (!reviewFlag) throw reviewsOff();
  const text = reply.trim();
  if (!text) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Write a reply first.' });
  await assertReviewText(text);
  const [review] = await dbWrite.$queryRaw<{ id: number }[]>`
    UPDATE "ServiceDealReview"
    SET "sellerReply" = ${text}, "sellerReplyAt" = now(), "sellerReplyScanStatus" = 'Pending',
      "sellerReplyScanWorkflowId" = NULL, "updatedAt" = now()
    WHERE "dealId" = ${dealId}::int AND "sellerId" = ${userId}::int
      AND "sellerReply" IS NULL AND "hiddenAt" IS NULL
    RETURNING "id"`;
  if (!review) throw dealChanged();
  await scanServiceDealReviewText('ServiceDealReviewReply', review.id);
}

/** A moderator hides or restores a review; its offering is recounted when that changes what shows. */
export async function setServiceDealReviewHidden({
  reviewId,
  moderatorId,
  hidden,
}: {
  reviewId: number;
  moderatorId: number;
  hidden: boolean;
}) {
  return dbWrite.$transaction(async (tx) => {
    const [review] = await tx.$queryRaw<{ dealId: number }[]>`
      UPDATE "ServiceDealReview"
      SET "hiddenAt" = CASE WHEN ${hidden} THEN now() END,
        "hiddenById" = CASE WHEN ${hidden} THEN ${moderatorId}::int END
      WHERE "id" = ${reviewId}::int AND ("hiddenAt" IS NULL) = ${hidden}
      RETURNING "dealId"`;
    if (!review) return false;
    await syncDealReviewPublication(tx, review.dealId);
    return true;
  });
}
