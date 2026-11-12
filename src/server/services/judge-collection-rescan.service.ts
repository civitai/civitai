import { Prisma } from '@prisma/client';
import { NsfwLevel } from '~/server/common/enums';
import { hasScanWorkflowSql, legacyJudgeRatingSeedSql } from '~/server/common/judge-rating';
import { dbWrite } from '~/server/db/client';
import { IMAGE_RESCAN_RETRY_LIMIT } from '~/server/services/image-scan-failure';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

/**
 * Never scanned, over `Image` aliased `alias`: `Scanned` with no scan workflow, or waiting for a
 * manual level (`PendingManualAssignment`, which uploads to judge-rated collections got before
 * they were scanned).
 */
export const neverScannedImageSql = (alias: string) => {
  const i = Prisma.raw(`"${alias}"`);
  return Prisma.sql`(
    (${i}.ingestion = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"
      AND NOT ${hasScanWorkflowSql(alias)})
    OR ${i}.ingestion = ${ImageIngestionStatus.PendingManualAssignment}::"ImageIngestionStatus"
  )`;
};

/** Never scanned and not blocked: what may be sent to the scan. */
export const rescannableImageSql = (alias: string) => {
  const i = Prisma.raw(`"${alias}"`);
  return Prisma.sql`(${neverScannedImageSql(alias)}
    AND ${i}."blockedFor" IS NULL
    AND ${i}."nsfwLevel" != ${NsfwLevel.Blocked})`;
};

/**
 * Sends never-scanned images to the scan, once, seeding the level the judges applied as a legacy
 * floor in the same statement. `scope` narrows the rows further, over `Image` `i` and its `Post`
 * `p`. An image that is blocked, held for review or already queued or scanning is left alone; one
 * out of rescan retries is marked `Error` rather than left in a `Rescan` the scan would never
 * pick up. Returns the ids it queued and the ids it marked `Error`.
 */
export async function queueNeverScannedRescan(imageIds: number[], scope: Prisma.Sql) {
  if (!imageIds.length) return { queued: [] as number[], failed: [] as number[] };
  const outOfRetries = Prisma.sql`COALESCE((i."scanJobs"->>'retryCount')::int, 0) >= ${IMAGE_RESCAN_RETRY_LIMIT}`;
  const rows = await dbWrite.$queryRaw<{ id: number; ingestion: ImageIngestionStatus }[]>`
    UPDATE "Image" i
    SET
      "metadata" = ${legacyJudgeRatingSeedSql('i', Prisma.sql`p."collectionId"`)},
      ingestion = CASE WHEN ${outOfRetries}
        THEN ${ImageIngestionStatus.Error}::"ImageIngestionStatus"
        ELSE ${ImageIngestionStatus.Rescan}::"ImageIngestionStatus"
      END,
      "updatedAt" = NOW()
    FROM "Post" p
    WHERE p.id = i."postId"
      AND i.id IN (${Prisma.join(imageIds)})
      AND ${scope}
      AND ${rescannableImageSql('i')}
      AND i."needsReview" IS NULL
    RETURNING i.id, i.ingestion
  `;
  const queued = rows.filter((r) => r.ingestion === ImageIngestionStatus.Rescan).map((r) => r.id);
  const failed = rows.filter((r) => r.ingestion === ImageIngestionStatus.Error).map((r) => r.id);
  if (queued.length) {
    await dbWrite.$executeRaw`
      INSERT INTO "JobQueue" (type, "entityType", "entityId")
      SELECT 'ImageScan'::"JobQueueType", 'Image'::"EntityType", id
      FROM unnest(ARRAY[${Prisma.join(queued)}]::int[]) AS id
      ON CONFLICT DO NOTHING
    `;
  }
  return { queued, failed };
}
