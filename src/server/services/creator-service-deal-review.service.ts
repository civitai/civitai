import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { assertDealText, transitionDeal } from '~/server/services/creator-service-deal.service';
import { releaseDeal } from '~/server/services/creator-service-escrow.service';
import { scanServiceDealReviewText } from '~/server/services/service-deal-review-moderation.adapter';
import { SERVICE_DEAL_REVIEW_EDIT_MS } from '~/shared/constants/creator-services.constants';
import type { ServiceDealReviewVerdict } from '~/shared/utils/prisma/enums';

const ms = (value: number) => Prisma.sql`(${value}::int * interval '1 millisecond')`;

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
  if (!reviewFlag)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Reviews are not available.' });
  const text = comment?.trim() || null;
  await assertDealText(text);

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
    return insertReview(tx, dealId, 'NotQuite', text);
  });
  if (inserted === undefined) throw dealChanged();
  await scanComment(inserted, text);
  return { verdict };
}
