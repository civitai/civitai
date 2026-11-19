import { dbWrite } from '~/server/db/client';
import { logToAxiom, safeError } from '~/server/logging/client';
import {
  clearPendingImageRestore,
  readPendingImageRestores,
  unblockAccountDeletionImages,
} from '~/server/services/account-deletion-images';
import { refreshProfilePicturesForUsersLazy } from '~/server/services/refresh-profile-pictures-lazy';
import { createJob } from './job';

/**
 * Bounds a run rather than the backlog: every id the cap defers is still in the set on the next
 * tick.
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

async function filterRestored(userIds: number[]) {
  if (!userIds.length) return [];
  const rows = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT u.id FROM "User" u WHERE u.id = ANY(${userIds}) AND u."deletedAt" IS NULL
  `;
  const restored = new Set(rows.map((r) => r.id));
  return userIds.filter((id) => restored.has(id));
}

/**
 * Undoes the grace block `remove-deleted-user-images` wrote, off a worklist `restoreUser` names
 * rather than one this job discovers: the breadcrumb has no supporting index on ~120M `Image`
 * rows and a filtered `User` scan measures ~1.7s, which a cron this frequent would pay on every
 * tick to learn that nobody was restored. An empty set costs one SMEMBERS and no query at all.
 *
 * `refreshPictures` runs once, after the loop, for the accounts that had images unblocked or whose
 * reversal drained, before their worklist entries are cleared: the grace block cleared a `User.image` naming one of them, and the refresh puts it
 * back once the picture is servable again (`restoreClearedUserImages`).
 */
export async function runRestoreUserImages(
  refreshPictures: (userIds: number[]) => Promise<unknown> = refreshProfilePicturesForUsersLazy
) {
  const pending = await readPendingImageRestores();
  if (!pending.length) return { pending: 0, finished: 0, unblocked: 0, reDeleted: 0 };

  let unblocked = 0;
  let finished = 0;
  let reDeleted = 0;
  const refreshed: number[] = [];
  const drained: number[] = [];

  for (const userId of pending.slice(0, RESTORE_USERS_PER_RUN)) {
    // Re-deletion is terminal for this entry, not a state to wait out: the grace block is once
    // more correct, and `restoreUser` re-queues the id if the account is ever restored again.
    if (!(await isRestored(userId))) {
      await clearPendingImageRestore(userId);
      reDeleted++;
      continue;
    }

    try {
      const result = await unblockAccountDeletionImages(userId);
      unblocked += result.unblocked;
      if (result.unblocked > 0 || result.drained) refreshed.push(userId);
      // Dropped only once the reversal ran out of rows to claim: a pass cut short by its batch
      // ceiling has to be reached again next tick.
      if (result.drained) drained.push(userId);
    } catch (error) {
      // Batches before the throw may have committed; the refresh does nothing where none did.
      refreshed.push(userId);
      // Caught per account so one that cannot be reversed doesn't strand the rest behind it.
      logToAxiom({
        type: 'error',
        name: 'restore-user-images',
        message: (error as Error)?.message,
        error: safeError(error),
        userId,
      });
    }
  }

  // Before the worklist entries are cleared: a run cut short in between refreshes them next tick.
  // An account deleted again since its unblock is left out: its grace block clears the picture.
  const stillRestored = await filterRestored(refreshed);
  if (stillRestored.length) await refreshPictures(stillRestored);
  for (const userId of drained) {
    await clearPendingImageRestore(userId);
    finished++;
  }

  return { pending: pending.length, finished, unblocked, reDeleted };
}

export const restoreUserImages = createJob(
  'restore-user-images',
  '*/2 * * * *',
  () => runRestoreUserImages(),
  { lockExpiration: 30 * 60, dedicated: true }
);
