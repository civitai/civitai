import { chunk } from 'lodash-es';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import { deleteImageFromS3 } from '~/server/services/image.service';
import { EntityType, JobQueueType } from '~/shared/utils/prisma/enums';

export const RETRY_BATCH_SIZE = 500;
const CONCURRENCY = 5;

type QueueRow = { id: number; url: string | null };

/**
 * The migration adding the label and column is applied after the deploy, so this job ships ahead
 * of both. Probing the catalog keeps it a quiet no-op until then, rather than a job error every run.
 */
async function isQueueReady() {
  const [row] = await dbWrite.$queryRaw<{ ready: boolean }[]>`
    SELECT
      EXISTS (
        SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'JobQueueType' AND e.enumlabel = ${JobQueueType.ImageStorageDelete}
      )
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'JobQueue' AND column_name = 'url'
      ) AS ready
  `;
  return row?.ready === true;
}

export const retryImageStorageDeletes = createJob(
  'retry-image-storage-deletes',
  '7,22,37,52 * * * *',
  async () => {
    if (!(await isQueueReady())) return { ready: false };

    const rows = await dbWrite.$queryRaw<QueueRow[]>`
      SELECT "entityId" AS id, url
      FROM "JobQueue"
      WHERE type = ${JobQueueType.ImageStorageDelete}::"JobQueueType"
        AND "entityType" = ${EntityType.Image}::"EntityType"
      ORDER BY "createdAt" ASC
      LIMIT ${RETRY_BATCH_SIZE}
    `;
    if (!rows.length) return { deleted: 0, skipped: 0, failed: 0 };

    // A local run, or an app pointed at a restored prod snapshot, must never delete production media.
    if (!isProd || !env.DATABASE_IS_PROD) return { wouldRetry: rows.length };

    const done: number[] = [];
    const failed: number[] = [];
    let deleted = 0;
    let skipped = 0;

    for (const batch of chunk(rows, CONCURRENCY)) {
      await Promise.all(
        batch.map(async ({ id, url }) => {
          // No key means nothing to delete and nothing to retry with.
          if (!url) {
            skipped++;
            done.push(id);
            return;
          }
          const outcome = await deleteImageFromS3({ id, url });
          if (outcome === 'failed') failed.push(id);
          else {
            if (outcome === 'deleted') deleted++;
            else skipped++;
            done.push(id);
          }
        })
      );
    }

    if (done.length)
      await dbWrite.$executeRaw`
        DELETE FROM "JobQueue"
        WHERE type = ${JobQueueType.ImageStorageDelete}::"JobQueueType"
          AND "entityType" = ${EntityType.Image}::"EntityType"
          AND "entityId" = ANY(${done}::integer[])
      `;

    // To the back of the line, so a key that keeps failing cannot starve the rest of the queue.
    if (failed.length)
      await dbWrite.$executeRaw`
        UPDATE "JobQueue" SET "createdAt" = now()
        WHERE type = ${JobQueueType.ImageStorageDelete}::"JobQueueType"
          AND "entityType" = ${EntityType.Image}::"EntityType"
          AND "entityId" = ANY(${failed}::integer[])
      `;

    const result = { deleted, skipped, failed: failed.length };
    logToAxiom({ name: 'retry-image-storage-deletes', type: 'info', ...result }).catch(
      () => undefined
    );
    return result;
  },
  { lockExpiration: 20 * 60 }
);
