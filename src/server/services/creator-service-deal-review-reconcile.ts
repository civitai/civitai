import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import {
  TEXT_MODERATION_EXHAUSTED_RESEND_AFTER_HOURS,
  TEXT_MODERATION_RETRY_LIMIT,
} from '~/server/jobs/text-moderation-retry.constants';
import { logToAxiom } from '~/server/logging/client';
import {
  happySortKey,
  offeringReviewTotals,
  recountOfferingReviews,
  reviewPublic,
  syncDealReviewPublication,
} from '~/server/services/creator-service-deal-review-publish';
import {
  scanServiceDealReviewText,
  unaskableServiceDealReviewTypes,
} from '~/server/services/service-deal-review-moderation.adapter';
import {
  SERVICE_DEAL_REVIEW_TEXTS,
  type ServiceDealReviewTextType,
} from '~/server/services/text-scan/profiles/service-deal-review.profile';
import { SERVICE_DEAL_DISPUTE_WINDOW_MS } from '~/shared/constants/creator-services.constants';

/**
 * A review text the reconcile sends: one whose check was never recorded (its submit failed, or a
 * dismissed csam hold sent it back) and whose row is not the retry job's, or one whose row spent its
 * retries a day ago, e.g. through an outage. The wait lets a submit in progress record its check
 * first. A hidden review's scan is skipped, so it is left out rather than resent every run.
 */
function unsentTexts(type: ServiceDealReviewTextType, limit: number) {
  const cols = SERVICE_DEAL_REVIEW_TEXTS[type];
  // Pending counts as unsettled on both sides: under the limit a lost Pending check is the retry
  // job's to resend, and the retry job never takes a row at the limit, Pending or not.
  const unsettledRow = Prisma.sql`SELECT 1 FROM "EntityModeration" em WHERE em."entityType" = ${type}
    AND em."entityId" = r."id" AND em."status" <> 'Succeeded'`;
  return Prisma.sql`(SELECT r."id", ${type}::text AS "type" FROM "ServiceDealReview" r
    WHERE r.${cols.status} IN ('Pending', 'Error') AND r.${cols.text} IS NOT NULL
      AND r."hiddenAt" IS NULL AND r."updatedAt" < now() - interval '15 minutes'
      AND ((r.${cols.status} = 'Pending' AND r.${cols.workflow} IS NULL
          AND NOT EXISTS (${unsettledRow}))
        OR EXISTS (${unsettledRow} AND em."retryCount" >= ${TEXT_MODERATION_RETRY_LIMIT}::int
          AND em."updatedAt" < now() - ${TEXT_MODERATION_EXHAUSTED_RESEND_AFTER_HOURS}::int
            * interval '1 hour'))
    ORDER BY r."id" LIMIT ${limit})`;
}

async function rescanUnsentTexts(
  limit: number,
  submitCheck?: Parameters<typeof scanServiceDealReviewText>[2]
) {
  // In active mode every text would be refused at submit, each refusal spending a retry.
  if ((await unaskableServiceDealReviewTypes()).length) {
    logToAxiom({
      type: 'warning',
      name: 'service-deal-review-reconcile',
      message: 'review text scan cannot ask every required label; no texts rescanned',
    });
    return 0;
  }
  const rows = await dbWrite.$queryRaw<{ id: number; type: ServiceDealReviewTextType }[]>`
    ${unsentTexts('ServiceDealReview', limit)}
    UNION ALL
    ${unsentTexts('ServiceDealReviewReply', limit)}`;
  for (const { id, type } of rows) await scanServiceDealReviewText(type, id, submitCheck);
  return rows.length;
}

/** Reviews whose shown state no longer matches their deal, e.g. after a dispute resolution. */
async function syncDriftedPublications(limit: number) {
  const rows = await dbWrite.$queryRaw<{ dealId: number }[]>`
    SELECT r."dealId" FROM "ServiceDealReview" r JOIN "ServiceDeal" d ON d."id" = r."dealId"
    WHERE (r."publishedAt" IS NULL) = ${reviewPublic}
    ORDER BY r."id" LIMIT ${limit}`;
  let synced = 0;
  for (const { dealId } of rows)
    if (await dbWrite.$transaction((tx) => syncDealReviewPublication(tx, dealId))) synced++;
  return synced;
}

/**
 * Read-backs of the release-on-review invariants over recent deals, each zero when the feature
 * works. A mismatch is logged, not repaired, so a person looks at it.
 */
export async function readBackServiceDealReviews() {
  const [counts] = await dbWrite.$queryRaw<
    {
      eventsWithoutReview: number;
      unpaidHappy: number;
      earlyRelease: number;
    }[]
  >`
    SELECT
      (SELECT count(*)::int FROM "ServiceDeal" d JOIN "ServiceDealEvent" e ON e."dealId" = d."id"
        WHERE d."reviewEnabledAt" IS NOT NULL AND d."completedAt" > now() - interval '30 days'
          AND e."type" = 'ReviewedHappy'::"ServiceDealEventType"
          AND (SELECT count(*) FROM "ServiceDealReview" r
            WHERE r."dealId" = e."dealId" AND r."verdict" = 'Happy'::"ServiceDealReviewVerdict") <> 1
      ) AS "eventsWithoutReview",
      (SELECT count(*)::int FROM "ServiceDeal" d
        WHERE d."reviewEnabledAt" IS NOT NULL AND d."completedAt" > now() - interval '30 days'
          AND EXISTS (SELECT 1 FROM "ServiceDealEvent" e WHERE e."dealId" = d."id"
            AND e."type" = 'ReviewedHappy'::"ServiceDealEventType"
            AND e."createdAt" < now() - interval '10 minutes')
          AND d."status" <> 'Disputed'::"ServiceDealStatus" AND d."settledAt" IS NULL
          AND NOT EXISTS (SELECT 1 FROM "ServiceDealTransaction" t
            WHERE t."dealId" = d."id" AND t."leg" = 'Release'::"ServiceDealLeg")
      ) AS "unpaidHappy",
      (SELECT count(*)::int FROM "ServiceDeal" d
        WHERE d."status" = 'Completed'::"ServiceDealStatus" AND d."disputeResolvedAt" IS NULL
          AND d."completedAt" > now() - interval '30 days'
          AND d."releaseAt" < d."completedAt"
            + (${SERVICE_DEAL_DISPUTE_WINDOW_MS}::int * interval '1 millisecond')
          AND NOT EXISTS (SELECT 1 FROM "ServiceDealEvent" e WHERE e."dealId" = d."id"
            AND e."type" = 'ReviewedHappy'::"ServiceDealEventType")
      ) AS "earlyRelease"`;
  if (Object.values(counts).some((n) => n > 0))
    logToAxiom({
      name: 'creator-service-deal-review',
      type: 'error',
      message: 'release-on-review read-back mismatch',
      payload: counts,
    });
  return counts;
}

/**
 * Offerings whose counters differ from their rows with no review having changed state: a buyer
 * banned or deleted since. The counters' read-back: each one found is logged, then recounted.
 */
async function recountDriftedOfferings(limit: number) {
  const rows = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT o."id" FROM "ServiceOffering" o CROSS JOIN LATERAL ${offeringReviewTotals(
      Prisma.sql`o."id"`
    )} t
    WHERE EXISTS (SELECT 1 FROM "ServiceDealReview" r WHERE r."offeringId" = o."id")
      AND (o."happyCount", o."reviewCount", o."happySortKey")
      IS DISTINCT FROM (t.happy, t.total, ${happySortKey(Prisma.sql`t.happy`, Prisma.sql`t.total`)})
    ORDER BY o."id" LIMIT ${limit}`;
  for (const { id } of rows) await recountOfferingReviews(id);
  if (rows.length)
    logToAxiom({
      name: 'creator-service-deal-review',
      type: 'warning',
      message: 'offering review counters recounted',
      payload: { offeringIds: rows.map((r) => r.id) },
    });
  return rows.length;
}

/**
 * The deals job's review step: recheck stranded texts, fix drifted publications, then read back.
 * `counters` also recounts drifted offerings, a pass over every reviewed offering the job runs hourly.
 */
export async function reconcileServiceDealReviews({
  limit,
  counters = false,
  submitCheck,
}: {
  limit: number;
  counters?: boolean;
  /** The content check's submit; the text scan's by default. */
  submitCheck?: Parameters<typeof scanServiceDealReviewText>[2];
}) {
  const rescanned = await rescanUnsentTexts(limit, submitCheck);
  const synced = await syncDriftedPublications(limit);
  const recounted = counters ? await recountDriftedOfferings(limit) : 0;
  const readBack = await readBackServiceDealReviews();
  return { rescanned, synced, recounted, ...readBack };
}
