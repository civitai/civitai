import { chunk } from 'lodash-es';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import { imageStorageDeletePayloadSchema } from '~/server/schema/job-queue.schema';
import { logToAxiom } from '~/server/logging/client';
import { deleteImageFromS3 } from '~/server/services/image.service';
import { EntityType, JobQueueType } from '~/shared/utils/prisma/enums';

const STORAGE_DELETE_BATCH_SIZE = 500;
const OLDEST_SHARE = 100;
const CONCURRENCY = 5;
const LOCK_SECONDS = 20 * 60;
/**
 * No new batch starts past this. During a storage outage a single key can take minutes, and a run
 * that outlives its lock is joined by the next trigger working the same oldest rows.
 */
export const RUN_BUDGET_MS = 12 * 60 * 1000;
const DEADLINE_MARGIN_MS = 2 * 60 * 1000;

type QueueRow = { id: number; data: unknown };

/** Deletes the stored files of deleted images, queued by the DELETE itself (`deleteImageRows`). */
export const imageStorageDeletes = createJob(
  'image-storage-deletes',
  '* * * * *',
  async () => {
    const startedAt = Date.now();
    // The budget only stops new batches; this bounds the one in flight, before the lock lapses.
    const deadline = AbortSignal.timeout(LOCK_SECONDS * 1000 - DEADLINE_MARGIN_MS);

    // Most of a run goes to the newest first attempts, so one delete is not queued behind a whole
    // account's wipe; a share goes to the oldest, so a run that works through its batch reaches the
    // oldest first attempts (one cut short by the budget can leave them unattempted). Retries come
    // last in that share, so keys that keep failing cannot hold back new deletes, and wait out a
    // backlog of first attempts. Failed rows keep their original
    // `createdAt`: it is what the overdue check in `JOB_QUEUE_OVERDUE_MINUTES` reads, so a key that
    // never clears has to age.
    const queued = await dbWrite.$queryRaw<QueueRow[]>`
      (SELECT "entityId" AS id, data FROM "JobQueue"
       WHERE type = ${JobQueueType.ImageStorageDelete}::"JobQueueType"
         AND "entityType" = ${EntityType.Image}::"EntityType"
         AND data->>'attempted' IS NULL
       ORDER BY "createdAt" DESC
       LIMIT ${STORAGE_DELETE_BATCH_SIZE - OLDEST_SHARE})
      UNION ALL
      (SELECT "entityId" AS id, data FROM "JobQueue"
       WHERE type = ${JobQueueType.ImageStorageDelete}::"JobQueueType"
         AND "entityType" = ${EntityType.Image}::"EntityType"
       ORDER BY (data->>'attempted') IS NOT NULL, "createdAt" ASC
       LIMIT ${OLDEST_SHARE})
    `;
    const rows = [...new Map(queued.map((row) => [row.id, row])).values()];
    if (!rows.length) return { deleted: 0, skipped: 0, failed: 0, malformed: 0, unattempted: 0 };

    // A non-production database queued no production file, so its rows are dropped rather than left
    // to pile up and read as overdue. A non-prod app on production's database leaves them for
    // production's run.
    if (!env.DATABASE_IS_PROD) {
      await removeRows(rows.map((row) => row.id));
      return { dropped: rows.length };
    }
    if (!isProd) return { wouldDelete: rows.length };

    const done: number[] = [];
    const failedIds: number[] = [];
    const malformed: number[] = [];
    let deleted = 0;
    let skipped = 0;
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
          const { url, allVersions, keepShopArtwork, attempted } = payload.data;
          const outcome = await deleteImageFromS3({
            id,
            url,
            allVersions,
            keepShopArtwork,
            // Only the first failure purges the resize cache: an outage would otherwise re-purge
            // every queued key on every run.
            purgeOnFailure: !attempted,
            abortSignal: deadline,
          }).catch(() => 'failed' as const);
          if (outcome === 'failed') {
            failedIds.push(id);
            return;
          }
          if (outcome === 'deleted') deleted++;
          else skipped++;
          done.push(id);
        })
      );
    }

    await removeRows(done);
    if (failedIds.length)
      await dbWrite.$executeRaw`
        UPDATE "JobQueue" SET data = data || '{"attempted": true}'::jsonb
        WHERE type = ${JobQueueType.ImageStorageDelete}::"JobQueueType"
          AND "entityType" = ${EntityType.Image}::"EntityType"
          AND "entityId" = ANY(${failedIds}::integer[])
          AND data->>'attempted' IS NULL
      `;

    if (malformed.length)
      logToAxiom({
        name: 'image-storage-deletes',
        type: 'warning',
        message: 'queued rows without a usable storage key were dropped',
        imageIds: malformed,
      });

    const result = {
      deleted,
      skipped,
      failed: failedIds.length,
      malformed: malformed.length,
      unattempted: rows.length - attempted,
    };
    logToAxiom({ name: 'image-storage-deletes', type: 'info', ...result });
    return result;
  },
  { lockExpiration: LOCK_SECONDS }
);

async function removeRows(ids: number[]) {
  if (!ids.length) return;
  await dbWrite.$executeRaw`
    DELETE FROM "JobQueue"
    WHERE type = ${JobQueueType.ImageStorageDelete}::"JobQueueType"
      AND "entityType" = ${EntityType.Image}::"EntityType"
      AND "entityId" = ANY(${ids}::integer[])
  `;
}
