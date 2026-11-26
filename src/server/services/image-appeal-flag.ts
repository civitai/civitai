import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { FEEDBACK_CAPTURE_OWNER_ID } from '@civitai/shared/feedback-capture';
import { CSAM_REPORT_LISTED_IMAGE_IDS_SQL } from '@civitai/shared/held-media';
import { AppealStatus, EntityType } from '~/shared/utils/prisma/enums';
import { csamBlockedSql, pendingImageAppealSql } from '~/server/common/image-visibility';

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
 * Once a report is filed, the report takes over from the moderator-only flag. Cleared only on an
 * image blocked as CSAM, and only where the owner has an open report and their oldest open report is younger than
 * `CSAM_HOLD_MAX_DAYS - REPORT_HOLD_RELEASE_MARGIN_DAYS`, so a report that does not name the image's
 * owner (no owner on the report, another account's image) leaves the flag on. A feedback page capture
 * has no owner a report can name, so any report listing it releases it.
 */
export async function releaseReviewFlagsToReportHold(imageIds: number[]): Promise<number> {
  if (!imageIds.length) return 0;
  return dbWrite.$transaction(async (tx) => {
    const cleared = await tx.$queryRaw<{ id: number }[]>`
    UPDATE "Image" i
    SET "needsReview" = NULL
    WHERE i.id IN (${Prisma.join(imageIds)})
      AND i."needsReview" = 'csam'
      AND i.ingestion = 'Blocked'
      -- The CSAM block keeps the image in its case once the flag is gone.
      AND i."blockedFor" = 'CSAM'
      AND (
        (
          i."userId" <> ${FEEDBACK_CAPTURE_OWNER_ID}
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
        )
        OR (
          i."userId" = ${FEEDBACK_CAPTURE_OWNER_ID}
          AND (i.id)::text IN (${Prisma.raw(CSAM_REPORT_LISTED_IMAGE_IDS_SQL)})
        )
      )
    RETURNING i.id
    `;
    // Drops their blocks' deferred effects unfired. A statement of its own, after the UPDATE took
    // the row locks, so it sees a row a block committed while the UPDATE waited.
    if (cleared.length)
      await tx.$executeRaw`
        DELETE FROM "ImageDeferredBlockEffect" WHERE "imageId" = ANY(${cleared.map(
          (c) => c.id
        )}::int[])
      `;
    return cleared.length;
  });
}

/**
 * Puts the flag back on any of these images whose appeal is still Pending, unless it holds a CSAM
 * block.
 */
export async function keepPendingAppealFlags(imageIds: number[]): Promise<void> {
  if (!imageIds.length) return;
  await dbWrite.$executeRaw`
    UPDATE "Image" i
    SET "needsReview" = 'appeal'
    WHERE i.id IN (${Prisma.join(imageIds)})
      AND i."needsReview" IS DISTINCT FROM 'appeal'
      AND i."needsReview" IS DISTINCT FROM 'csam'
      AND (${csamBlockedSql('i')}) IS NOT TRUE
      AND ${pendingImageAppealSql(Prisma.sql`i.id`)}
  `;
}

/**
 * Takes the appeal flag off any of these images whose appeal is no longer Pending, for a path that
 * closes appeals itself: nothing else would clear it, and a blocking scan keeps a stored one.
 */
export async function releaseSettledAppealFlags(imageIds: number[]): Promise<number> {
  if (!imageIds.length) return 0;
  return dbWrite.$executeRaw`
    UPDATE "Image" i
    SET "needsReview" = NULL
    WHERE i.id IN (${Prisma.join(imageIds)})
      AND i."needsReview" = 'appeal'
      AND NOT ${pendingImageAppealSql(Prisma.sql`i.id`)}
  `;
}
