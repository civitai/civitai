import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { AppealStatus, EntityType } from '~/shared/utils/prisma/enums';

/**
 * The appeals queue lists images by `needsReview = 'appeal'`, and the blocked-image purge spares
 * Blocked images by that flag. So while an Appeal is Pending the flag must stay, whatever else
 * rewrites the image.
 */

export async function getPendingAppealImageIds(imageIds: number[]): Promise<Set<number>> {
  if (!imageIds.length) return new Set();
  const rows = await dbWrite.appeal.findMany({
    where: {
      entityType: EntityType.Image,
      status: AppealStatus.Pending,
      entityId: { in: imageIds },
    },
    select: { entityId: true },
  });
  return new Set(rows.map((r) => r.entityId));
}

/**
 * A block settles every review flag except the moderator-only one, which only its own queue, a
 * filed report or an explicit unblock may clear. Run after the block, not folded into it: Prisma cannot express the CASE,
 * and a conditional UPDATE re-reads the flag under the row lock.
 */
export async function clearReviewFlagsOnBlock(imageIds: number[]): Promise<void> {
  if (!imageIds.length) return;
  await dbWrite.$executeRaw`
    UPDATE "Image" i
    SET "needsReview" = NULL
    WHERE i.id IN (${Prisma.join(imageIds)})
      AND i."needsReview" IS NOT NULL
      AND i."needsReview" <> 'csam'
  `;
}

/**
 * Ceiling on the purge hold an open report places on its owner's blocked images, measured from the
 * owner's oldest open report, not from the block: the send/archive pipeline has no retry limit, so
 * a report nobody finishes would otherwise hold them forever, and clocking it from the block would
 * shrink each report's budget by however old the block already was.
 */
export const CSAM_HOLD_MAX_DAYS = 30;

/**
 * How much of that hold a report filing must still have left before it takes the moderator-only flag
 * off. Without it, a report filed against an owner whose oldest open report is near the ceiling would
 * drop the flag onto a hold that lapses within hours.
 */
export const REPORT_HOLD_RELEASE_MARGIN_DAYS = 7;

/**
 * Once a report is filed, the purge hold keyed on the owner's open report takes over from the
 * moderator-only flag. Cleared only where that hold covers the image with at least
 * `REPORT_HOLD_RELEASE_MARGIN_DAYS` to spare, so a report that does not hold it (no owner on the
 * report, another account's image, an owner whose hold has run out or nearly has) leaves the flag on.
 * Mirrors the hold in `remove-blocked-images`.
 */
export async function releaseReviewFlagsToReportHold(imageIds: number[]): Promise<number> {
  if (!imageIds.length) return 0;
  return dbWrite.$executeRaw`
    UPDATE "Image" i
    SET "needsReview" = NULL
    WHERE i.id IN (${Prisma.join(imageIds)})
      AND i."needsReview" = 'csam'
      AND i.ingestion = 'Blocked'
      AND EXISTS (
        SELECT 1 FROM "CsamReport" c
        WHERE c."userId" = i."userId"
          AND (c."reportSentAt" IS NULL OR c."archivedAt" IS NULL)
      )
      AND NOT EXISTS (
        SELECT 1 FROM "CsamReport" c
        WHERE c."userId" = i."userId"
          AND (c."reportSentAt" IS NULL OR c."archivedAt" IS NULL)
          AND c."createdAt" <= now() - ${
            CSAM_HOLD_MAX_DAYS - REPORT_HOLD_RELEASE_MARGIN_DAYS
          } * interval '1 day'
      )
  `;
}

/** Puts the flag back on any of these images whose appeal is still Pending. */
export async function keepPendingAppealFlags(imageIds: number[]): Promise<void> {
  if (!imageIds.length) return;
  await dbWrite.$executeRaw`
    UPDATE "Image" i
    SET "needsReview" = 'appeal'
    WHERE i.id IN (${Prisma.join(imageIds)})
      AND i."needsReview" IS DISTINCT FROM 'appeal'
      AND i."needsReview" IS DISTINCT FROM 'csam'
      AND EXISTS (
        SELECT 1 FROM "Appeal" a
        WHERE a."entityType" = 'Image' AND a."entityId" = i.id AND a."status" = 'Pending'
      )
  `;
}
