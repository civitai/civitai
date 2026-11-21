import {
  serviceReviewReportActionAllowed,
  type ServiceReviewReportAction,
} from '@civitai/shared/post-text-report';
import { dbWrite } from '~/server/db/client';
import { trackModActivity } from '~/server/services/moderator.service';
import {
  lockDealReviewCounters,
  syncDealReviewPublication,
} from '~/server/services/creator-service-deal-review-publish';
import { setServiceDealReviewHidden } from '~/server/services/creator-service-deal-review.service';
import { flagImagesForCsamReview } from '~/server/services/csam-image-review';
import { evictHomeBlocksForImages } from '~/server/services/home-block-cache.service';
import { lockCsamHold, pendingCsamHoldFields } from '~/server/services/text-scan/actions/csam-hold';
import {
  loadServiceDealReviewSubjects,
  SERVICE_DEAL_REVIEW_TEXTS,
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

/** Whether a report on this review may take this action (`serviceReviewReportActionAllowed`). */
export async function reportedServiceDealReviewActionAllowed(
  action: ServiceReviewReportAction,
  reportId: number,
  reviewId: number
) {
  const report = await getServiceDealReviewReportReason(reportId, reviewId);
  return !!report && serviceReviewReportActionAllowed(action, report);
}

/**
 * A moderator's csam hold on a reported review, which only a CSAM or minor-sexualization report on
 * this review opens. In one transaction: a Pending csam hold on the named text's current words (raised
 * even on words an earlier hold dismissed; a pending one is kept), that text blocked, and the whole
 * review hidden, images included. So a hold never exists over a text still shown, and a review with
 * no text, or a held reply, still comes down, and its images go to the CSAM review queue. `type` names
 * a text when the review has any, and is null when it has none (`'pickText'` otherwise).
 */
export async function holdReportedServiceDealReview({
  reviewId,
  type,
  moderatorId,
  reportId,
}: {
  reviewId: number;
  type: ServiceDealReviewTextType | null;
  moderatorId: number;
  reportId: number;
}): Promise<'refused' | 'pickText' | null | { holdId: number | null; changed: boolean }> {
  if (!(await reportedServiceDealReviewActionAllowed('hold', reportId, reviewId))) return 'refused';
  const subject = type
    ? (await loadServiceDealReviewSubjects(type, [reviewId])).get(reviewId)
    : null;
  if (type && !subject) return 'pickText';
  let flagged: number[] = [];
  const result = await dbWrite.$transaction(async (tx) => {
    const [review] = await tx.$queryRaw<{ dealId: number; hasText: boolean }[]>`
      SELECT "dealId", ("comment" IS NOT NULL OR "sellerReply" IS NOT NULL) AS "hasText"
      FROM "ServiceDealReview" WHERE "id" = ${reviewId}::int`;
    if (!review) return null;
    if (review.hasText !== (type !== null)) return 'pickText' as const;
    // The counters first, as every review writer takes them.
    await lockDealReviewCounters(tx, review.dealId);
    let hold: { holdId: number | null; changed: boolean } = { holdId: null, changed: false };
    if (type && subject) {
      // The lock the scan's hold writer and a decision take.
      await lockCsamHold(tx, type, reviewId);
      const [pending] = await tx.$queryRaw<{ id: number }[]>`
        SELECT "id" FROM "TextScanHold"
        WHERE "entityType" = ${type} AND "entityId" = ${reviewId}::int AND "label" = 'csam'
          AND "status" = 'Pending'`;
      if (pending) hold = { holdId: pending.id, changed: false };
      else {
        const { userId, text } = pendingCsamHoldFields(subject);
        const meta = { kind: 'moderator', moderatorId, reportId };
        const [inserted] = await tx.$queryRaw<{ id: number }[]>`
          INSERT INTO "TextScanHold" ("entityType", "entityId", "label", "textHash", "userId", "text",
            "reason", "meta", "updatedAt")
          VALUES (${type}, ${reviewId}::int, 'csam', ${textScanTextHash(subject)}, ${userId}::int,
            ${text}, ${`Moderator hold from report #${reportId}`}, ${JSON.stringify(
          meta
        )}::jsonb, now())
          RETURNING "id"`;
        hold = { holdId: inserted.id, changed: true };
      }
      const cols = SERVICE_DEAL_REVIEW_TEXTS[type];
      await tx.$executeRaw`
        UPDATE "ServiceDealReview" SET ${cols.status} = 'Blocked' WHERE "id" = ${reviewId}::int`;
    }
    // Its images go to the CSAM review queue, whose flag holds their owner's delete until it decides.
    const images = await tx.$queryRaw<{ imageId: number }[]>`
      SELECT "imageId" FROM "ServiceDealReviewImage" WHERE "reviewId" = ${reviewId}::int`;
    flagged = images.map((i) => i.imageId);
    if (flagged.length) await flagImagesForCsamReview(tx, flagged);
    const hidden = await tx.$executeRaw`
      UPDATE "ServiceDealReview" SET "hiddenAt" = now(), "hiddenById" = ${moderatorId}::int
      WHERE "id" = ${reviewId}::int AND "hiddenAt" IS NULL`;
    await syncDealReviewPublication(tx, review.dealId);
    return { holdId: hold.holdId, changed: hold.changed || hidden > 0 };
  });
  // After the commit, and first: it never throws.
  if (flagged.length) await evictHomeBlocksForImages({ imageIds: flagged });
  if (result && typeof result === 'object' && result.holdId !== null && result.changed)
    await trackModActivity(moderatorId, {
      entityType: 'serviceDealReview',
      entityId: reviewId,
      activity: 'csamHold',
    });
  return result;
}

/**
 * A moderator's hide or restore of a reported review. A hide needs a report on this review that may
 * be answered with one (never a CSAM report: that one is held). A restore is refused as every restore
 * is (`setServiceDealReviewHidden`).
 */
export async function setReportedServiceDealReviewHidden({
  reviewId,
  moderatorId,
  hidden,
  reportId,
}: {
  reviewId: number;
  moderatorId: number;
  hidden: boolean;
  reportId?: number;
}) {
  if (
    hidden &&
    !(reportId && (await reportedServiceDealReviewActionAllowed('hide', reportId, reviewId)))
  )
    return 'refused' as const;
  return setServiceDealReviewHidden({ reviewId, moderatorId, hidden });
}
