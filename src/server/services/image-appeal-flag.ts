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
