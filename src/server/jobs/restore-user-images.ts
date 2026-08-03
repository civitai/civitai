import { dbWrite } from '~/server/db/client';
import { logToAxiom, safeError } from '~/server/logging/client';
import {
  clearPendingImageRestore,
  readPendingImageRestores,
  unblockAccountDeletionImages,
} from '~/server/services/account-deletion-images';
import { createJob } from './job';

/**
 * Bounds a run rather than the backlog: a set this long only happens if Redis is holding ids for
 * accounts that were re-deleted, and every id the cap defers is still there on the next tick.
 */
export const RESTORE_USERS_PER_RUN = 25;

async function isRestored(userId: number) {
  const [row] = await dbWrite.$queryRaw<{ restored: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM "User" u WHERE u.id = ${userId} AND u."deletedAt" IS NULL
    ) AS restored
  `;
  return row?.restored ?? false;
}

/**
 * Undoes the grace block `remove-deleted-user-images` wrote, off a worklist `restoreUser` names
 * rather than one this job discovers: the breadcrumb has no supporting index on ~120M `Image`
 * rows and a filtered `User` scan measures ~1.7s, which a cron this frequent would pay on every
 * tick to learn that nobody was restored. An empty set costs one SMEMBERS and no query at all.
 */
export const restoreUserImages = createJob(
  'restore-user-images',
  '*/2 * * * *',
  async () => {
    const pending = await readPendingImageRestores();
    if (!pending.length) return { pending: 0, finished: 0, unblocked: 0, stillDeleted: 0 };

    let unblocked = 0;
    let finished = 0;
    let stillDeleted = 0;

    for (const userId of pending.slice(0, RESTORE_USERS_PER_RUN)) {
      // An account can be deleted again between the restore and this run, in which case the
      // reversal would undo a grace block that is once more the correct state.
      if (!(await isRestored(userId))) {
        stillDeleted++;
        continue;
      }

      try {
        const result = await unblockAccountDeletionImages(userId);
        unblocked += result.unblocked;
        // Dropped only once the reversal ran out of rows to claim: a pass cut short by its batch
        // ceiling has to be reached again next tick.
        if (result.drained) {
          await clearPendingImageRestore(userId);
          finished++;
        }
      } catch (error) {
        // Caught per account so one that cannot be reversed doesn't strand the rest behind it.
        await logToAxiom({
          type: 'error',
          name: 'restore-user-images',
          message: (error as Error)?.message,
          error: safeError(error),
          userId,
        }).catch(() => undefined);
      }
    }

    return { pending: pending.length, finished, unblocked, stillDeleted };
  },
  { lockExpiration: 30 * 60, dedicated: true }
);
