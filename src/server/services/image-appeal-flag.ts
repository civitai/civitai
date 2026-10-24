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
 * With `REPORT_HOLD_RELEASE_MARGIN_DAYS`, sets how old an owner's oldest open report may be for a
 * report filing to take the moderator-only flag off their blocked images: younger than
 * `CSAM_HOLD_MAX_DAYS - REPORT_HOLD_RELEASE_MARGIN_DAYS`, measured from that report, not the block.
 */
export const CSAM_HOLD_MAX_DAYS = 30;

/** See `CSAM_HOLD_MAX_DAYS`. */
export const REPORT_HOLD_RELEASE_MARGIN_DAYS = 7;

/**
 * Once a report is filed, the legal hold on the owner takes over from the moderator-only flag.
 * Cleared only where the owner has an open report and their oldest open report is younger than
 * `CSAM_HOLD_MAX_DAYS - REPORT_HOLD_RELEASE_MARGIN_DAYS`, so a report that does not name the image's
 * owner (no owner on the report, another account's image) leaves the flag on. Narrower than the legal
 * hold `remove-blocked-images` applies (`legal-hold.ts`), so an image released here is still held
 * there.
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
