import { Prisma } from '@prisma/client';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import { deleteImages } from '~/server/services/image.service';
import { accountHoldSql, holdMarkerViewExists } from '~/server/services/legal-hold.service';
import { PLACEHOLDER_OWNER_ID } from '~/server/utils/legal-hold';
import { EntityType, JobQueueType } from '~/shared/utils/prisma/enums';
import { REPLACED_IMAGE_RETENTION_DAYS } from '@civitai/shared/job-queue';
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
export { REPLACED_IMAGE_RETENTION_DAYS };

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

/** Ids from `ids` whose image still exists, read on the primary. */
async function getStillPresentImageIds(ids: number[]) {
  if (!ids.length) return [];
  const rows = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT id FROM "Image" WHERE id = ANY(${ids}::integer[])
  `;
  return rows.map((r) => r.id);
}

/**
 * The holds the reap re-checks on the DELETE itself: every hold on the owner's account, and the
 * placeholder owner. Only valid on a statement over an unaliased "Image". `markerView` is what
 * `holdMarkerViewExists` returned.
 */
export function replacedImageHoldGuard(markerView: boolean) {
  const owner = Prisma.raw('"Image"."userId"');
  return Prisma.sql`
    -- Read off the row itself, so a flag committed while this DELETE runs still holds the image.
    "Image"."needsReview" IS DISTINCT FROM 'csam'
    AND NOT (${owner} = ${PLACEHOLDER_OWNER_ID} OR ${accountHoldSql(owner, markerView)})
  `;
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

    const deleted: number[] = [];
    if (deletableIds.length) {
      // Deletes the row, the stored object, and the caches keyed on it. Past the retention
      // window there is nothing left to preserve, so this is the same destruction the inline
      // call used to do — just late enough that no live cache can still be pointing at it.
      // A held account's images are the exception, and the guard leaves them in place.
      const markerView = await holdMarkerViewExists();
      const rows = await deleteImages(deletableIds, true, {
        onlyWhere: replacedImageHoldGuard(markerView),
      });
      deleted.push(...rows.map((x) => x.id));
    }
    const deletedSet = new Set(deleted);
    const held = new Set(
      await getStillPresentImageIds(deletableIds.filter((id) => !deletedSet.has(id)))
    );

    // A held image stays queued until its hold ends. Everything else leaves: the deleted ones are
    // done, one deleted some other way has nothing left to reap, and a re-adopted one has no pending
    // replacement. If it is replaced again, the enqueue re-inserts it with a fresh clock (ON CONFLICT
    // DO UPDATE in `queueReplacedImageDeletion`).
    const dequeueIds = queuedIds.filter((id) => !held.has(id));
    if (dequeueIds.length) {
      await dbWrite.$executeRaw`
        DELETE FROM "JobQueue"
        WHERE type = ${JobQueueType.ReplacedImageDelete}::"JobQueueType"
          AND "entityType" = ${EntityType.Image}::"EntityType"
          AND "entityId" = ANY(${dequeueIds}::integer[])
      `;
    }

    logToAxiom({
      name: 'remove-replaced-images',
      type: 'info',
      message: 'finished',
      deleted: deleted.length,
      readopted: readopted.size,
      heldAtDelete: held.size,
    }).catch(() => undefined);

    return { deleted: deleted.length, readopted: readopted.size, heldAtDelete: held.size };
  },
  // A full batch means thousands of S3 deletes; a second pod grabbing the default 5-minute
  // lock mid-run would double-delete against S3 and the DB.
  { lockExpiration: 20 * 60 }
);
