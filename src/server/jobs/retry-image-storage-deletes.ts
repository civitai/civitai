import { chunk } from 'lodash-es';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import { imageStorageDeletePayloadSchema } from '~/server/schema/job-queue.schema';
import { logToAxiom } from '~/server/logging/client';
import { deleteImageFromS3 } from '~/server/services/image.service';
import { EntityType, JobQueueType } from '~/shared/utils/prisma/enums';

export const RETRY_BATCH_SIZE = 500;
const CONCURRENCY = 5;
const LOCK_SECONDS = 20 * 60;
/**
 * No new batch starts past this. During a storage outage a single key can take minutes, and a run
 * that outlives its lock is joined by the next trigger working the same oldest rows.
 */
export const RUN_BUDGET_MS = 12 * 60 * 1000;
const DEADLINE_MARGIN_MS = 2 * 60 * 1000;

type QueueRow = { id: number; data: unknown };

/**
 * The enum label is added after the deploy, so this job ships ahead of it. Probing the catalog
 * keeps it a quiet no-op until then, rather than a job error every run.
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
        WHERE table_name = 'JobQueue' AND column_name = 'data'
      ) AS ready
  `;
  return row?.ready === true;
}

export const retryImageStorageDeletes = createJob(
  'retry-image-storage-deletes',
  '7,22,37,52 * * * *',
  async () => {
    const startedAt = Date.now();
    // The budget only stops new batches; this bounds the one in flight, before the lock lapses.
    const deadline = AbortSignal.timeout(LOCK_SECONDS * 1000 - DEADLINE_MARGIN_MS);
    if (!(await isQueueReady())) return { ready: false };

    // Failed rows keep their original `createdAt`: it is what the overdue check in
    // `JOB_QUEUE_OVERDUE_MINUTES` reads, so a key that never clears has to age.
    const rows = await dbWrite.$queryRaw<QueueRow[]>`
      SELECT "entityId" AS id, data
      FROM "JobQueue"
      WHERE type = ${JobQueueType.ImageStorageDelete}::"JobQueueType"
        AND "entityType" = ${EntityType.Image}::"EntityType"
      ORDER BY "createdAt" ASC
      LIMIT ${RETRY_BATCH_SIZE}
    `;
    if (!rows.length) return { deleted: 0, skipped: 0, failed: 0, malformed: 0, unattempted: 0 };

    // A local run, or an app pointed at a restored prod snapshot, must never delete production media.
    if (!isProd || !env.DATABASE_IS_PROD) return { wouldRetry: rows.length };

    const done: number[] = [];
    const malformed: number[] = [];
    let deleted = 0;
    let skipped = 0;
    let failed = 0;
    let attempted = 0;

    for (const batch of chunk(rows, CONCURRENCY)) {
      if (Date.now() - startedAt > RUN_BUDGET_MS) break;
      attempted += batch.length;
      await Promise.all(
        batch.map(async ({ id, data }) => {
          const payload = imageStorageDeletePayloadSchema.safeParse(data);
          // No key means nothing to delete and nothing to retry with.
          if (!payload.success) {
            malformed.push(id);
            done.push(id);
            return;
          }
          const { url } = payload.data;
          const outcome = await deleteImageFromS3({
            id,
            url,
            purgeOnFailure: false,
            abortSignal: deadline,
          }).catch(() => 'failed' as const);
          if (outcome === 'failed') {
            failed++;
            return;
          }
          if (outcome === 'deleted') deleted++;
          else skipped++;
          done.push(id);
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

    if (malformed.length)
      logToAxiom({
        name: 'retry-image-storage-deletes',
        type: 'warning',
        message: 'queued rows without a usable storage key were dropped',
        imageIds: malformed,
      }).catch(() => undefined);

    const result = {
      deleted,
      skipped,
      failed,
      malformed: malformed.length,
      unattempted: rows.length - attempted,
    };
    logToAxiom({ name: 'retry-image-storage-deletes', type: 'info', ...result }).catch(
      () => undefined
    );
    return result;
  },
  { lockExpiration: LOCK_SECONDS }
);
