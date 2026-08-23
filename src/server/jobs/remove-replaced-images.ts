import { isProd } from '~/env/other';
import { env } from '~/env/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import { deleteImages } from '~/server/services/image.service';
import { EntityType, JobQueueType } from '~/shared/utils/prisma/enums';
import { decreaseDate } from '~/utils/date-helpers';

/**
 * Reaps images that were REPLACED rather than deleted — currently profile pictures swapped
 * out by `updateUserHandler`, which queues the old id instead of destroying it inline.
 *
 * The window has to outlast every cache that can still be holding the old url. The binding
 * one is the image CDN's redirect (`max-age=86400`), but the account-switcher roster in
 * localStorage is durable across sessions and only refreshed when the user next signs in,
 * so the right order of magnitude is days, not hours. 30 days is also what the repo already
 * uses for the same replaced-then-purge problem on model files (`purge-replaced-files`).
 */
export const REPLACED_IMAGE_RETENTION_DAYS = 30;

/** Bounds how much of a backlog one run pulls in. Oldest-first, so the remainder drains later. */
const BATCH_SIZE = 5000;

type QueueRow = { entityId: number };

/**
 * Ids from `ids` that are STILL somebody's profile picture and therefore must not be reaped.
 *
 * A user can re-select an image they previously replaced away from. That leaves a queue row
 * whose clock started at the earlier replacement pointing at an image that is live again —
 * so without this check the job would delete the user's CURRENT avatar, which is a strictly
 * worse version of the bug it exists to fix. Checked at reap time rather than at re-select
 * time on purpose: one guard on the destructive side beats keeping every adoption path in
 * sync with the queue.
 */
export async function getStillReferencedImageIds(ids: number[]) {
  if (!ids.length) return [];
  // dbWrite, not dbRead: the queue row is 30 days old but a re-adoption can be seconds old, and
  // one that landed inside replica lag would be invisible here — the job would then delete the
  // avatar the user just chose. `User.profilePictureId` is `@unique`, so this is an index probe.
  const rows = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT "profilePictureId" AS id
    FROM "User"
    WHERE "profilePictureId" = ANY(${ids}::integer[])
  `;
  return rows.map((r) => r.id);
}

export const removeReplacedImages = createJob(
  'remove-replaced-images',
  '25 5 * * *',
  async () => {
    const cutoff = decreaseDate(new Date(), REPLACED_IMAGE_RETENTION_DAYS, 'days');

    // The cutoff is applied in the query, not after the take: filtering afterwards would let
    // rows still inside their window occupy the oldest-first batch and starve the ones past it.
    const jobQueue = await dbRead.jobQueue.findMany({
      where: {
        type: JobQueueType.ReplacedImageDelete,
        entityType: EntityType.Image,
        createdAt: { lt: cutoff },
      },
      select: { entityId: true },
      take: BATCH_SIZE,
      orderBy: { createdAt: 'asc' },
    });

    if (!jobQueue.length) return { deleted: 0, readopted: 0 };

    const queuedIds = (jobQueue as QueueRow[]).map((j) => j.entityId);
    const readoptedIds = await getStillReferencedImageIds(queuedIds);
    const readopted = new Set(readoptedIds);
    const deletableIds = queuedIds.filter((id) => !readopted.has(id));

    // Same two guards `remove-blocked-images` carries: a local run, or an app pointed at a
    // non-prod copy, must never mass-delete production media out of a restored snapshot.
    if (!isProd) return { wouldDelete: deletableIds.length, readopted: readopted.size };
    if (!env.DATABASE_IS_PROD)
      return { wouldDelete: deletableIds.length, readopted: readopted.size };

    if (deletableIds.length) {
      // Deletes the row, the stored object, and the caches keyed on it. Past the retention
      // window there is nothing left to preserve, so this is the same destruction the inline
      // call used to do — just late enough that no live cache can still be pointing at it.
      await deleteImages(deletableIds);
    }

    // Both cohorts leave the queue: the deleted ones are done, and a re-adopted one has no
    // pending replacement to reap. If it is replaced again, the enqueue re-inserts it with a
    // fresh clock (ON CONFLICT DO UPDATE in `queueReplacedImageDeletion`).
    await dbWrite.$executeRaw`
      DELETE FROM "JobQueue"
      WHERE type = ${JobQueueType.ReplacedImageDelete}::"JobQueueType"
        AND "entityType" = ${EntityType.Image}::"EntityType"
        AND "entityId" = ANY(${queuedIds}::integer[])
    `;

    logToAxiom({
      name: 'remove-replaced-images',
      type: 'info',
      message: 'finished',
      deleted: deletableIds.length,
      readopted: readopted.size,
    }).catch(() => undefined);

    return { deleted: deletableIds.length, readopted: readopted.size };
  },
  // A full batch means thousands of S3 deletes; a second pod grabbing the default 5-minute
  // lock mid-run would double-delete against S3 and the DB.
  { lockExpiration: 20 * 60 }
);
