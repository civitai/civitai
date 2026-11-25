import { sql } from '@civitai/db/kysely';
import { liveCsamTextHoldText } from '@civitai/shared/held-url';
import type {
  ReportedServiceReview,
  ServiceReviewAction,
  ServiceReviewText,
} from '$lib/service-review-report';
import { dbWrite } from './db';
import { callModEndpoint } from './user-actions.service';
import { holdsCsamReview } from './held-media';
import { listWithheldIds } from './retracted-media';

const heldText = (entityType: string) =>
  sql<boolean>`EXISTS (SELECT 1 FROM "TextScanHold" th
    WHERE th."entityType" = ${entityType} AND th."entityId" = r.id
      AND ${sql.raw(liveCsamTextHoldText('th'))})`;

/**
 * The reviews these reports are about, keyed by report id; a report not on a review is absent. Read
 * on the primary, so a hide or hold just made shows on the reload. An image withheld from `viewer`
 * is sent with no key.
 */
export async function getReportedServiceReviews(
  reportIds: number[],
  viewer: App.Locals['user'] | undefined
): Promise<Map<number, ReportedServiceReview>> {
  const ids = [...new Set(reportIds)].filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return new Map();

  const rows = await dbWrite
    .selectFrom('ServiceDealReviewReport as rr')
    .innerJoin('ServiceDealReview as r', 'r.id', 'rr.serviceDealReviewId')
    .innerJoin('Report as rep', 'rep.id', 'rr.reportId')
    .select([
      'rr.reportId',
      'r.id as reviewId',
      'r.dealId',
      sql<string>`r.verdict::text`.as('verdict'),
      'r.comment',
      'r.sellerReply',
      sql<string | null>`rep.details -> 'serviceDealReview' ->> 'comment'`.as('reportedComment'),
      sql<string | null>`rep.details -> 'serviceDealReview' ->> 'sellerReply'`.as('reportedReply'),
      sql<boolean>`r."publishedAt" IS NOT NULL`.as('shown'),
      sql<boolean>`r."hiddenAt" IS NOT NULL`.as('hidden'),
      heldText('ServiceDealReview').as('commentHeld'),
      heldText('ServiceDealReviewReply').as('replyHeld'),
      sql<{ id: number; url: string }[]>`coalesce((
        SELECT json_agg(json_build_object('id', i.id, 'url', i.url) ORDER BY i.id)
        FROM "ServiceDealReviewImage" ri JOIN "Image" i ON i.id = ri."imageId"
        WHERE ri."reviewId" = r.id
      ), '[]'::json)`.as('images'),
    ])
    .where('rr.reportId', 'in', ids)
    .execute();

  const withheld = await listWithheldIds(
    rows.flatMap((row) => row.images.map((image) => image.id)),
    { csamReview: holdsCsamReview(viewer) },
    'service-review-reports'
  );
  return new Map(
    rows.map(({ reportId, ...review }) => [
      reportId,
      {
        ...review,
        images: review.images.map((image) =>
          withheld.has(image.id) ? { id: image.id, url: '', restricted: true as const } : image
        ),
      },
    ])
  );
}

/** The review a report names, read from its own row: never from the form. */
export async function getReportServiceReview(reportId: number) {
  const row = await dbWrite
    .selectFrom('ServiceDealReviewReport as rr')
    .innerJoin('Report as rep', 'rep.id', 'rr.reportId')
    .innerJoin('ServiceDealReview as r', 'r.id', 'rr.serviceDealReviewId')
    .select([
      'rr.serviceDealReviewId as reviewId',
      'rep.reason',
      'rep.details',
      sql<boolean>`r.comment IS NOT NULL OR r."sellerReply" IS NOT NULL`.as('hasText'),
    ])
    .where('rr.reportId', '=', reportId)
    .executeTakeFirst();
  return row ?? null;
}

/** The main app makes the write and its audit row; this app resolves the report after. */
export async function moderateServiceReview(input: {
  reviewId: number;
  action: ServiceReviewAction;
  text?: ServiceReviewText;
  reportId: number;
}): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }> {
  const result = await callModEndpoint(
    'creator-services/review-report',
    input,
    'Moderate service review'
  );
  if (!result.ok) {
    // A timeout, dropped socket or server error may come after the main app made the write.
    const mayHaveApplied = !result.requestNeverSent && (result.status ?? 500) >= 500;
    return {
      ok: false,
      error: mayHaveApplied
        ? 'The main app did not answer and the change may have gone through. Reload to check before trying again.'
        : result.error,
    };
  }
  return { ok: true, changed: result.body.changed === true };
}
