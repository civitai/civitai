import { dbWrite } from '~/server/db/client';
import { chunk } from 'lodash-es';
import { Prisma } from '@prisma/client';
import { EntityType, JobQueueType } from '~/shared/utils/prisma/enums';

export async function enqueueJobs(
  jobs: { entityId: number; entityType: EntityType; type: JobQueueType }[]
) {
  if (!jobs?.length) return;

  const batches = chunk(jobs, 500);
  for (const batch of batches) {
    await dbWrite.$executeRaw`
      INSERT INTO "JobQueue" ("entityId", "entityType", "type")
      VALUES ${Prisma.join(
        batch.map(
          ({ entityId, entityType, type }) =>
            Prisma.sql`(${entityId}::integer, ${entityType}::"EntityType", ${type}::"JobQueueType")`
        )
      )}
      ON CONFLICT DO NOTHING;
    `;
  }
}

/**
 * Drop the ImageScan JobQueue rows for images that have reached a terminal scan
 * outcome (Scanned/Blocked). Called from the scan-result webhook so completed
 * scans clean up immediately instead of lingering as stale rows the ingest-images
 * cron has to prune — stale rows bloat the queue and starve fresh work. Idempotent
 * (composite-PK delete); safe to call with ids that were never queued. Error scans
 * are intentionally left in place so the cron can retry them.
 */
export async function removeImageScanJobQueue(imageIds: number[]) {
  if (!imageIds.length) return;

  await dbWrite.$executeRaw`
    DELETE FROM "JobQueue"
    WHERE type = ${JobQueueType.ImageScan}::"JobQueueType"
      AND "entityType" = ${EntityType.Image}::"EntityType"
      AND "entityId" = ANY(${imageIds})
  `;
}
