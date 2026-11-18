import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { userUnderLegalHoldSql } from '~/server/utils/legal-hold';
import {
  SERVICE_DEAL_FILE_RETENTION_CLOSED_MS,
  SERVICE_DEAL_FILE_RETENTION_COMPLETED_MS,
} from '~/shared/constants/creator-services.constants';

// `d` names the deal row and `o` its offering in every fragment below. This only marks files
// removed; purgeRemovedFiles deletes them, and re-checks the holds.

const ms = (value: number) => Prisma.sql`(${value}::bigint * interval '1 millisecond')`;

/**
 * The deal is over and its money settled. A held deal whose refund or release has not landed keeps
 * its files.
 */
const dealClosedAndSettled = Prisma.sql`(
  d."status" IN ('Declined', 'Expired', 'Cancelled', 'Completed')
  AND (d."heldAt" IS NULL OR d."settledAt" IS NOT NULL)
)`;

/**
 * When the retention clock starts, restarted by later moderation of the deal or its offering.
 * GREATEST skips nulls and is null only if all are, so a deal with no close time never expires.
 */
const clockStart = Prisma.sql`GREATEST(
  CASE WHEN d."status" = 'Completed' THEN d."releaseAt" ELSE d."closedAt" END,
  d."disputeResolvedAt",
  CASE WHEN o."removedReason" IS NOT NULL THEN o."removedAt" END,
  (SELECT max(GREATEST(r."createdAt", r."statusSetAt"))
   FROM "ServiceOfferingReport" sr JOIN "Report" r ON r."id" = sr."reportId"
   WHERE sr."serviceOfferingId" = o."id")
)`;

const retentionExpired = Prisma.sql`(
  ${clockStart} + CASE WHEN d."status" = 'Completed'
    THEN ${ms(SERVICE_DEAL_FILE_RETENTION_COMPLETED_MS)}
    ELSE ${ms(SERVICE_DEAL_FILE_RETENTION_CLOSED_MS)} END <= now()
)`;

const parties = Prisma.sql`(d."buyerId", d."sellerId")`;

/** Anything that keeps a deal's files, on either party or the offering. */
export const dealFilesHeld = Prisma.sql`(
  ${userUnderLegalHoldSql(Prisma.sql`d."buyerId"`)}
  OR ${userUnderLegalHoldSql(Prisma.sql`d."sellerId"`)}
  OR EXISTS (SELECT 1 FROM "CsamReport" c
    WHERE c."userId" IN ${parties}
      OR c."details" ->> 'secondaryUserId' IN (d."buyerId"::text, d."sellerId"::text))
  OR EXISTS (SELECT 1 FROM "ServiceOfferingReport" sr JOIN "Report" r ON r."id" = sr."reportId"
    WHERE sr."serviceOfferingId" = o."id" AND r."status"::text IN ('Pending', 'Processing'))
  OR EXISTS (SELECT 1 FROM "Appeal" a
    WHERE a."userId" IN ${parties} AND a."status"::text = 'Pending')
  OR EXISTS (SELECT 1 FROM "ModActivity" m
    WHERE m."entityType" = 'user' AND m."entityId" IN ${parties}
      AND m."activity" LIKE 'chargeback:%')
)`;

/** Marks the files of deals past their retention, and not held, as removed. Returns how many. */
export async function markExpiredDealFiles({ limit = 200 } = {}) {
  const marked = await dbWrite.$executeRaw`
    UPDATE "ServiceDealFile" SET "removedAt" = now()
    WHERE "id" IN (
      SELECT f."id" FROM "ServiceDealFile" f
      JOIN "ServiceDeal" d ON d."id" = f."dealId"
      JOIN "ServiceOffering" o ON o."id" = d."offeringId"
      WHERE f."removedAt" IS NULL
        AND ${dealClosedAndSettled} AND ${retentionExpired} AND NOT ${dealFilesHeld}
      ORDER BY f."id" LIMIT ${limit}::int
      FOR UPDATE OF f SKIP LOCKED
    )`;
  return marked;
}

/**
 * For a deleted account: marks the files the user uploaded (finals and previews as the seller,
 * attachments as the buyer) on their closed, settled deals as removed, under the same holds. A deal
 * still open or unsettled keeps them on its own retention clock, as it does the other party's.
 */
export const markUserDealUploadsRemovedSql = (userId: number) => Prisma.sql`
  UPDATE "ServiceDealFile" f SET "removedAt" = now()
  FROM "ServiceDeal" d JOIN "ServiceOffering" o ON o."id" = d."offeringId"
  WHERE f."dealId" = d."id" AND f."removedAt" IS NULL
    AND CASE WHEN f."kind"::text = 'Attachment' THEN d."buyerId" ELSE d."sellerId" END = ${userId}::int
    AND ${dealClosedAndSettled} AND NOT ${dealFilesHeld}`;
