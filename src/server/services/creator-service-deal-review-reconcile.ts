import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  happySortKey,
  offeringReviewTotals,
  recountOfferingReviews,
  reviewPublic,
  syncDealReviewPublication,
} from '~/server/services/creator-service-deal-review-publish';
import { scanServiceDealReviewText } from '~/server/services/service-deal-review-moderation.adapter';
import { SERVICE_DEAL_DISPUTE_WINDOW_MS } from '~/shared/constants/creator-services.constants';

/**
 * Review texts whose check was never recorded: its submit failed, or a dismissed csam hold sent
 * the text back. A quarter hour lets a submit in progress record its check first. A recorded check
 * that fails is retried by the moderation retry cron, not here. A hidden review's scan is skipped,
 * so it is left out rather than resent every run.
 */
async function rescanUnsubmittedTexts(limit: number) {
  const rows = await dbWrite.$queryRaw<
    { id: number; type: 'ServiceDealReview' | 'ServiceDealReviewReply' }[]
  >`
    (SELECT "id", 'ServiceDealReview' AS "type" FROM "ServiceDealReview"
      WHERE "scanStatus" = 'Pending' AND "scanWorkflowId" IS NULL AND "comment" IS NOT NULL
        AND "hiddenAt" IS NULL
        AND "updatedAt" < now() - interval '15 minutes'
      ORDER BY "id" LIMIT ${limit})
    UNION ALL
    (SELECT "id", 'ServiceDealReviewReply' AS "type" FROM "ServiceDealReview"
      WHERE "sellerReplyScanStatus" = 'Pending' AND "sellerReplyScanWorkflowId" IS NULL
        AND "sellerReply" IS NOT NULL AND "hiddenAt" IS NULL
        AND "updatedAt" < now() - interval '15 minutes'
      ORDER BY "id" LIMIT ${limit})`;
  for (const { id, type } of rows) await scanServiceDealReviewText(type, id);
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
 * The release-on-review read-backs, each zero when the feature works:
 * - a happy-review event without exactly one happy review;
 * - a happy-reviewed deal not paid within ten minutes, unless it is held or settled otherwise;
 * - a completed deal released before its dispute window ended with no happy review and no
 *   dispute resolution behind it;
 * - an offering whose counters differ from a recount of its rows.
 * A mismatch is logged, not repaired, so a person looks at it.
 */
export async function readBackServiceDealReviews() {
  const [counts] = await dbWrite.$queryRaw<
    {
      eventsWithoutReview: number;
      unpaidHappy: number;
      earlyRelease: number;
      counterDrift: number;
    }[]
  >`
    SELECT
      (SELECT count(*)::int FROM "ServiceDealEvent" e
        WHERE e."type" = 'ReviewedHappy'::"ServiceDealEventType"
          AND (SELECT count(*) FROM "ServiceDealReview" r
            WHERE r."dealId" = e."dealId" AND r."verdict" = 'Happy'::"ServiceDealReviewVerdict") <> 1
      ) AS "eventsWithoutReview",
      (SELECT count(*)::int FROM "ServiceDeal" d
        WHERE EXISTS (SELECT 1 FROM "ServiceDealEvent" e WHERE e."dealId" = d."id"
            AND e."type" = 'ReviewedHappy'::"ServiceDealEventType"
            AND e."createdAt" < now() - interval '10 minutes')
          AND d."status" <> 'Disputed'::"ServiceDealStatus" AND d."settledAt" IS NULL
          AND NOT EXISTS (SELECT 1 FROM "ServiceDealTransaction" t
            WHERE t."dealId" = d."id" AND t."leg" = 'Release'::"ServiceDealLeg")
      ) AS "unpaidHappy",
      (SELECT count(*)::int FROM "ServiceDeal" d
        WHERE d."status" = 'Completed'::"ServiceDealStatus" AND d."disputeResolvedAt" IS NULL
          AND d."releaseAt" < d."completedAt"
            + (${SERVICE_DEAL_DISPUTE_WINDOW_MS}::int * interval '1 millisecond')
          AND NOT EXISTS (SELECT 1 FROM "ServiceDealEvent" e WHERE e."dealId" = d."id"
            AND e."type" = 'ReviewedHappy'::"ServiceDealEventType")
      ) AS "earlyRelease",
      (SELECT count(*)::int FROM "ServiceOffering" o CROSS JOIN LATERAL ${offeringReviewTotals(
        Prisma.sql`o."id"`
      )} t
        WHERE (o."happyCount", o."reviewCount", o."happySortKey")
          IS DISTINCT FROM (t.happy, t.total, ${happySortKey(
            Prisma.sql`t.happy`,
            Prisma.sql`t.total`
          )})
      ) AS "counterDrift"`;
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
 * banned or deleted since. Logged when found, so a recount that should have happened is visible.
 */
async function recountDriftedOfferings(limit: number) {
  const rows = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT o."id" FROM "ServiceOffering" o CROSS JOIN LATERAL ${offeringReviewTotals(
      Prisma.sql`o."id"`
    )} t
    WHERE (o."happyCount", o."reviewCount", o."happySortKey")
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
 * The deals job's review step: recheck stranded texts, fix drifted publications and counters, then
 * read back. Counter drift that survives the recount is what the read-back reports.
 */
export async function reconcileServiceDealReviews({ limit }: { limit: number }) {
  const rescanned = await rescanUnsubmittedTexts(limit);
  const synced = await syncDriftedPublications(limit);
  const recounted = await recountDriftedOfferings(limit);
  const readBack = await readBackServiceDealReviews();
  return { rescanned, synced, recounted, ...readBack };
}
