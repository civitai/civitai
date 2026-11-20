import { reportOpensCsamHold } from '@civitai/shared/post-text-report';
import { dbWrite } from '~/server/db/client';
import { trackModActivity } from '~/server/services/moderator.service';
import { blockServiceDealReviewText } from '~/server/services/service-deal-review-moderation.adapter';
import {
  csamHoldLockKey,
  pendingCsamHoldFields,
} from '~/server/services/text-scan/actions/csam-hold';
import {
  loadServiceDealReviewSubjects,
  type ServiceDealReviewTextType,
} from '~/server/services/text-scan/profiles/service-deal-review.profile';
import { textScanTextHash } from '~/server/services/text-scan/prompt';

/** The reason a report on this review gives, or null when the report is not on this review. */
async function getServiceDealReviewReportReason(reportId: number, reviewId: number) {
  // primary: the report may have been filed a moment ago.
  const [row] = await dbWrite.$queryRaw<{ reason: string; details: unknown }[]>`
    SELECT rep."reason"::text AS "reason", rep."details"
    FROM "ServiceDealReviewReport" r JOIN "Report" rep ON rep."id" = r."reportId"
    WHERE r."reportId" = ${reportId}::int AND r."serviceDealReviewId" = ${reviewId}::int`;
  return row ?? null;
}

/**
 * Sends one of a reported review's texts (the buyer's comment or the seller's reply) to the CSAM
 * text-hold queue: a Pending csam hold on its current words, raised even on words an earlier hold
 * dismissed, and the text blocked so it is not shown until the hold is decided there. A text with a
 * pending hold already is left in it (`changed: false`). Null when the review has no such text.
 */
async function holdServiceDealReviewTextForCsam({
  reviewId,
  type,
  moderatorId,
  reportId,
}: {
  reviewId: number;
  type: ServiceDealReviewTextType;
  moderatorId: number;
  reportId: number;
}): Promise<{ holdId: number; changed: boolean } | null> {
  const subject = (await loadServiceDealReviewSubjects(type, [reviewId])).get(reviewId);
  if (!subject) return null;
  const result = await dbWrite.$transaction(async (tx) => {
    // The scan's hold writer and a decision take the same lock (`lockCsamHold`).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${csamHoldLockKey(
      type
    )}), ${reviewId}::int)`;
    const [pending] = await tx.$queryRaw<{ id: number }[]>`
      SELECT "id" FROM "TextScanHold"
      WHERE "entityType" = ${type} AND "entityId" = ${reviewId}::int AND "label" = 'csam'
        AND "status" = 'Pending'`;
    if (pending) return { holdId: pending.id, changed: false };
    const { userId, text } = pendingCsamHoldFields(subject);
    const meta = { kind: 'moderator', moderatorId, reportId };
    const [hold] = await tx.$queryRaw<{ id: number }[]>`
      INSERT INTO "TextScanHold" ("entityType", "entityId", "label", "textHash", "userId", "text",
        "reason", "meta", "updatedAt")
      VALUES (${type}, ${reviewId}::int, 'csam', ${textScanTextHash(subject)}, ${userId}::int,
        ${text}, ${`Moderator hold from report #${reportId}`}, ${JSON.stringify(
      meta
    )}::jsonb, now())
      RETURNING "id"`;
    return { holdId: hold.id, changed: true };
  });
  // After the hold commits, as the scan's own hold does before its verdict: a dismissal requeues it.
  await blockServiceDealReviewText(type, reviewId);
  if (result.changed)
    await trackModActivity(moderatorId, {
      entityType: 'serviceDealReview',
      entityId: reviewId,
      activity: 'csamHold',
    });
  return result;
}

/**
 * A moderator's csam hold on a reported review's text, which only a CSAM or minor-sexualization report
 * on this review opens (T&S, hub mail 2026-11-20-224207-28bf58b5). `refused` when the report is not
 * on this review or gives another reason; null when the review has no such text.
 */
export async function holdReportedServiceDealReviewText(args: {
  reviewId: number;
  type: ServiceDealReviewTextType;
  moderatorId: number;
  reportId: number;
}) {
  const report = await getServiceDealReviewReportReason(args.reportId, args.reviewId);
  if (!report || !reportOpensCsamHold(report)) return 'refused' as const;
  return holdServiceDealReviewTextForCsam(args);
}
