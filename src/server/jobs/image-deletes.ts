import { dequeueImageDeletes, unusedImage } from '@civitai/db-queries/content-deletion';
import { Prisma } from '@prisma/client';
import { sql } from 'kysely';
import { dbWrite } from '~/server/db/client';
import { kyselyOver } from '~/server/db/prisma-kysely';
import { fromPrismaSql } from '~/server/db/prisma-sql-kysely';
import { createJob } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import { deleteImages } from '~/server/services/image.service';
import { ownerHeldSql } from '~/server/services/legal-hold.service';
import { EntityType, JobQueueType } from '~/shared/utils/prisma/enums';

const BATCH_SIZE = 500;

type QueueRow = { id: number; moderatorDelete: boolean };

/**
 * What the DELETE re-checks: an owner under a hold, or with a safety report on file, keeps every
 * image, since the review needs them. Only valid on a statement over an unaliased "Image".
 */
export const queuedImageDeleteGuard = () => Prisma.sql`
  NOT ${ownerHeldSql(Prisma.raw('"Image"."userId"'))}
  AND NOT EXISTS (SELECT 1 FROM "CsamReport" r WHERE r."userId" = "Image"."userId")
`;

/**
 * What the job's DELETE takes: an image still unused as its parent's delete queued it, since it may
 * have been linked again since (a cover swapped back), and whose owner the guard does not keep.
 */
export const queuedImageDeleteCondition = (moderatorDelete: boolean) =>
  sql<boolean>`${fromPrismaSql<boolean>(queuedImageDeleteGuard())} AND ${unusedImage({
    moderatorDelete,
  })}`;

/**
 * Deletes the images a parent's delete queued (`queueImageDeletes`), as a system delete, unless
 * `queuedImageDeleteCondition` now keeps them.
 */
export const imageDeletes = createJob('image-deletes', '* * * * *', async () => {
  // First attempts before retries, so images that keep failing cannot hold back new ones.
  const rows = await dbWrite.$queryRaw<QueueRow[]>`
    SELECT "entityId" AS id, COALESCE((data->>'moderatorDelete')::boolean, false) AS "moderatorDelete"
    FROM "JobQueue"
    WHERE type = ${JobQueueType.ImageDelete}::"JobQueueType"
      AND "entityType" = ${EntityType.Image}::"EntityType"
    ORDER BY (data->>'attempted') IS NOT NULL, "createdAt" ASC
    LIMIT ${BATCH_SIZE}
  `;
  if (!rows.length) return { queued: 0, deleted: 0, failed: 0 };

  // An id already gone, linked again or kept by a hold is done with too: its row goes either way.
  const run = async (ids: number[], moderatorDelete: boolean) => {
    const deleted = await deleteImages(ids, {
      actor: { system: 'image-deletes' },
      onlyWhere: queuedImageDeleteCondition(moderatorDelete),
      moderatorDelete,
    });
    await dequeueImageDeletes(kyselyOver(dbWrite), ids);
    return deleted.length;
  };

  let deleted = 0;
  const failed: number[] = [];
  for (const moderatorDelete of [false, true]) {
    const ids = rows.filter((row) => row.moderatorDelete === moderatorDelete).map((row) => row.id);
    if (!ids.length) continue;
    try {
      deleted += await run(ids, moderatorDelete);
    } catch {
      // One at a time, so an image that keeps failing cannot hold back the rest.
      for (const id of ids)
        deleted += await run([id], moderatorDelete).catch(() => {
          failed.push(id);
          return 0;
        });
    }
  }

  if (failed.length) {
    await dbWrite.$executeRaw`
      UPDATE "JobQueue" SET data = COALESCE(data, '{}'::jsonb) || '{"attempted": true}'::jsonb
      WHERE type = ${JobQueueType.ImageDelete}::"JobQueueType"
        AND "entityType" = ${EntityType.Image}::"EntityType"
        AND "entityId" = ANY(${failed}::integer[])
    `;
    logToAxiom({
      name: 'image-deletes',
      type: 'error',
      message: 'queued image deletes failed',
      imageIds: failed,
    });
  }

  return { queued: rows.length, deleted, failed: failed.length };
});
