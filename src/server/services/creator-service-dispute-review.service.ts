import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  getServiceDealFileAccessRecordedSince,
  listServiceDealFileAccess,
} from '~/server/services/creator-service-deal-file-access';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import type { ServiceDisputeResolution } from '~/shared/utils/prisma/enums';

export const DISPUTE_REVIEW_CLASSES = ['A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'C'] as const;
export type DisputeReviewClass = (typeof DISPUTE_REVIEW_CLASSES)[number];
export const DISPUTE_REVIEW_MODES = ['shadow', 'propose', 'settle'] as const;
export type DisputeReviewMode = (typeof DISPUTE_REVIEW_MODES)[number];

const PRIOR_DISPUTE_DAYS = 90;

const partyRefused = () =>
  new TRPCError({
    code: 'FORBIDDEN',
    message: 'You are the buyer or seller on this deal. Another moderator must review it.',
  });

/**
 * Records one review of a Disputed deal. The deal is read FOR SHARE, so a review racing a resolve
 * waits for it and is then refused, never written after the ruling it should have preceded.
 */
export async function createServiceDisputeReview({
  dealId,
  reviewerId,
  class: reviewClass,
  proposal,
  confidence,
  rationale,
  evidence,
  agentVersion,
  mode,
}: {
  dealId: number;
  reviewerId: number;
  class: DisputeReviewClass;
  proposal: ServiceDisputeResolution | null;
  confidence: number | null;
  rationale: string;
  evidence: unknown;
  agentVersion: string;
  mode: DisputeReviewMode;
}) {
  const [row] = await dbWrite.$queryRaw<
    { status: string; party: boolean; id: number | null; createdAt: Date | null }[]
  >`
    WITH deal AS (
      SELECT "id", "status"::text AS "status",
        ${reviewerId}::int IN ("buyerId", "sellerId") AS "party"
      FROM "ServiceDeal" WHERE "id" = ${dealId}::int FOR SHARE
    ), ins AS (
      INSERT INTO "ServiceDisputeReview"
        ("dealId", "class", "proposal", "confidence", "rationale", "evidence", "agentVersion", "mode")
      SELECT "id", ${reviewClass}, ${proposal}::"ServiceDisputeResolution", ${confidence}::float8,
        ${rationale}, ${JSON.stringify(evidence ?? {})}::jsonb, ${agentVersion}, ${mode}
      FROM deal WHERE "status" = 'Disputed' AND NOT "party"
      RETURNING "id", "createdAt"
    )
    SELECT deal."status", deal."party", ins."id", ins."createdAt" FROM deal LEFT JOIN ins ON true`;
  if (!row) throw throwNotFoundError('Deal not found');
  if (row.party) throw partyRefused();
  if (row.id === null)
    throw new TRPCError({
      code: 'CONFLICT',
      message: `Only a Disputed deal can be reviewed; this one is ${row.status}.`,
    });
  return { id: row.id, createdAt: row.createdAt };
}

/** Fills the latest review's human ruling. Runs inside the resolve transaction, under its lock. */
export const recordHumanRulingSql = (
  dealId: number,
  moderatorId: number,
  resolution: ServiceDisputeResolution
) => Prisma.sql`
  UPDATE "ServiceDisputeReview"
  SET "humanRuling" = ${resolution}::"ServiceDisputeResolution", "humanId" = ${moderatorId}::int,
      "agreed" = CASE WHEN "proposal" IS NULL THEN NULL
                      ELSE "proposal" = ${resolution}::"ServiceDisputeResolution" END
  WHERE "id" = (
    SELECT "id" FROM "ServiceDisputeReview" WHERE "dealId" = ${dealId}::int
    ORDER BY "createdAt" DESC, "id" DESC LIMIT 1
  )`;

export type ServiceDisputeReviewSummary = {
  id: number;
  dealId: number;
  class: string;
  proposal: ServiceDisputeResolution | null;
  confidence: number | null;
  rationale: string;
  agentVersion: string;
  mode: string;
  createdAt: Date;
};

/** The latest review of each deal that has one. */
export async function getLatestServiceDisputeReviews(dealIds: number[]) {
  if (!dealIds.length) return [];
  return dbWrite.$queryRaw<ServiceDisputeReviewSummary[]>`
    SELECT DISTINCT ON ("dealId") "id", "dealId", "class", "proposal"::text AS "proposal",
      "confidence", "rationale", "agentVersion", "mode", "createdAt"
    FROM "ServiceDisputeReview"
    WHERE "dealId" IN (${Prisma.join(dealIds.map((id) => Prisma.sql`${id}::int`))})
    ORDER BY "dealId", "createdAt" DESC, "id" DESC`;
}

/**
 * Everything a review reads for one deal, in one bundle. A moderator who is a party is refused, as
 * resolving refuses them. The access summary fails open to null: it lives in ClickHouse.
 */
export async function getServiceDisputeEvidence({
  dealId,
  viewerId,
}: {
  dealId: number;
  viewerId: number;
}) {
  const [deal] = await dbWrite.$queryRaw<
    {
      id: number;
      status: string;
      buyerId: number;
      sellerId: number;
      sellerUnavailable: boolean;
      price: number;
      buzzType: string;
      feeAmount: number;
      revisionsIncluded: number;
      revisionsUsed: number;
      deliveryDays: number;
      previewKind: string;
      maxNsfwLevel: number;
      requestText: string;
      requestedAt: Date;
      acceptedAt: Date | null;
      dueAt: Date | null;
      deliveredAt: Date | null;
      completedAt: Date | null;
      releaseAt: Date | null;
      cancellationRequestedAt: Date | null;
      cancellationReason: string | null;
      disputeOpenedAt: Date | null;
      disputeReason: string | null;
      disputeResolution: string | null;
      offeringId: number;
      offeringTitle: string;
      offeringDescription: string;
    }[]
  >`
    SELECT d."id", d."status"::text AS "status", d."buyerId", d."sellerId",
      (s."bannedAt" IS NOT NULL OR s."deletedAt" IS NOT NULL) AS "sellerUnavailable",
      d."price", d."buzzType"::text AS "buzzType", d."feeAmount", d."revisionsIncluded",
      d."revisionsUsed", d."deliveryDays", d."previewKind"::text AS "previewKind", d."maxNsfwLevel",
      d."requestText", d."requestedAt", d."acceptedAt", d."dueAt", d."deliveredAt", d."completedAt",
      d."releaseAt", d."cancellationRequestedAt", d."cancellationReason", d."disputeOpenedAt",
      d."disputeReason", d."disputeResolution"::text AS "disputeResolution",
      o."id" AS "offeringId", o."title" AS "offeringTitle", o."description" AS "offeringDescription"
    FROM "ServiceDeal" d
    JOIN "ServiceOffering" o ON o."id" = d."offeringId"
    JOIN "User" s ON s."id" = d."sellerId"
    WHERE d."id" = ${dealId}::int`;
  if (!deal) throw throwNotFoundError('Deal not found');
  if (viewerId === deal.buyerId || viewerId === deal.sellerId) throw partyRefused();

  const [events, files, prior, access] = await Promise.all([
    dbWrite.$queryRaw<
      {
        id: number;
        type: string;
        actorId: number;
        round: number | null;
        comment: string | null;
        reasonCode: string | null;
        createdAt: Date;
      }[]
    >`
      SELECT "id", "type"::text AS "type", "actorId", "round", "comment", "reasonCode", "createdAt"
      FROM "ServiceDealEvent" WHERE "dealId" = ${dealId}::int ORDER BY "createdAt", "id"`,
    dbWrite.$queryRaw<
      {
        id: number;
        kind: string;
        round: number;
        status: string;
        scanStatus: string;
        malwareScanStatus: string;
        failReason: string | null;
        fileName: string;
        mimeType: string;
        size: number;
        deliverySize: number | null;
        uploadedAt: Date | null;
      }[]
    >`
      SELECT "id", "kind"::text AS "kind", "round", "status"::text AS "status",
        "scanStatus"::text AS "scanStatus", "malwareScanStatus"::text AS "malwareScanStatus",
        "failReason", "fileName", "mimeType", "size", "deliverySize", "uploadedAt"
      FROM "ServiceDealFile" WHERE "dealId" = ${dealId}::int ORDER BY "round", "id"`,
    dbWrite.$queryRaw<{ buyer: number; seller: number }[]>`
      SELECT
        count(*) FILTER (WHERE ${deal.buyerId}::int IN ("buyerId", "sellerId"))::int AS "buyer",
        count(*) FILTER (WHERE ${deal.sellerId}::int IN ("buyerId", "sellerId"))::int AS "seller"
      FROM "ServiceDeal"
      WHERE "id" <> ${dealId}::int
        AND "disputeOpenedAt" >= now() - ${Prisma.raw(`interval '${PRIOR_DISPUTE_DAYS} days'`)}
        AND (${deal.buyerId}::int IN ("buyerId", "sellerId")
          OR ${deal.sellerId}::int IN ("buyerId", "sellerId"))`,
    readAccess(dealId),
  ]);

  const { offeringId, offeringTitle, offeringDescription, ...dealFields } = deal;
  return {
    deal: dealFields,
    offering: { id: offeringId, title: offeringTitle, description: offeringDescription },
    events,
    files: files.map((file) => ({
      ...file,
      access: access?.rows.filter((a) => a.fileId === file.id).map(({ dealId: _, ...a }) => a),
    })),
    accessRecordedSince: access?.recordedSince ?? null,
    priorDisputes: { days: PRIOR_DISPUTE_DAYS, ...(prior[0] ?? { buyer: 0, seller: 0 }) },
  };
}

async function readAccess(dealId: number) {
  try {
    const [rows, recordedSince] = await Promise.all([
      listServiceDealFileAccess([dealId]),
      getServiceDealFileAccessRecordedSince(),
    ]);
    return { rows, recordedSince };
  } catch (error) {
    logToAxiom({
      name: 'creator-service-file-access',
      type: 'error',
      message: 'Could not read deal file accesses for dispute evidence',
      dealId,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => null);
    return null;
  }
}
