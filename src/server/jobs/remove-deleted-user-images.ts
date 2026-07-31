import { Prisma } from '@prisma/client';
import { chunk } from 'lodash-es';
import { BlockedReason, NsfwLevel } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom, safeError } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { deleteImages } from '~/server/services/image.service';
import { createJob, getJobDate } from './job';

export const USERS_PER_RUN = 50;
export const DELETE_BATCH_SIZE = 100;
export const DEFAULT_IMAGES_PER_RUN = 500;

/**
 * Two cursors because the populations move in opposite directions and one cursor cannot serve
 * both: a fresh self-deletion has to be purged within a tick or two, while the 74,828-account
 * backlog takes months. FRESH is an ascending high-water mark over accounts deleted after the
 * mark; BACKLOG is a descending cursor over everything below it. Collapsing them back into a
 * single cursor strands every new deletion behind the whole backlog — in *either* direction,
 * since a descending cursor sorts each new deletion above its own position.
 */
export const FRESH_CURSOR_KEY = 'remove-deleted-user-images-fresh-cursor';
export const BACKLOG_CURSOR_KEY = 'remove-deleted-user-images-cursor';

/** Backlog wrap sentinel: above every possible `deletedAt`, so a reset restarts the descent. */
export const CURSOR_START = new Date('9999-12-31T23:59:59.999Z');

/**
 * sysRedis.get is typed `string | null`, but the HA/Sentinel client can return
 * a Buffer at runtime — coerce explicitly so the type stays honest and this
 * stays safe if the parsing below ever grows string-sensitive (`.split`, `===`).
 */
export async function getImagePurgeBudget(): Promise<number> {
  const raw = await sysRedis.get(REDIS_SYS_KEYS.SYSTEM.DELETED_USER_IMAGE_PURGE_LIMIT);
  if (raw == null) return DEFAULT_IMAGES_PER_RUN;
  const parsed = Number(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_IMAGES_PER_RUN;
  // A fractional budget reaches Postgres as `LIMIT 1.5`, which errors out every user in the run.
  return Math.floor(parsed);
}

type Candidate = { id: number; deletedAt: Date; mode: 'grace' | 'immediate' };

type UserDrain = {
  deletedImages: number;
  blockedImages: number;
  budgetUsed: number;
  drained: boolean;
  canceled: boolean;
  error?: unknown;
};

async function isStillDeleted(userId: number) {
  const [row] = await dbWrite.$queryRaw<{ stillDeleted: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM "User" u WHERE u.id = ${userId} AND u."deletedAt" IS NOT NULL
    ) AS "stillDeleted"
  `;
  return row.stillDeleted;
}

async function drainUser(
  userId: number,
  budget: number,
  isCanceled: () => boolean
): Promise<UserDrain> {
  let deletedImages = 0;
  let budgetUsed = 0;

  try {
    // Joined rather than trusted from the worklist: that was read off a replica, so a
    // restore (or replica lag) between the two would otherwise purge a live account.
    const images = await dbWrite.$queryRaw<{ id: number }[]>`
      SELECT i.id
      FROM "Image" i
      JOIN "User" u ON u.id = i."userId" AND u."deletedAt" IS NOT NULL
      WHERE i."userId" = ${userId}
      LIMIT ${budget}
    `;

    for (const batch of chunk(
      images.map((i) => i.id),
      DELETE_BATCH_SIZE
    )) {
      if (isCanceled())
        return { deletedImages, blockedImages: 0, budgetUsed, drained: false, canceled: true };
      // The id list is only as fresh as the fetch above, and the delete below is by id: without
      // a re-read a restore landing mid-drain still costs the account every id already fetched.
      if (!(await isStillDeleted(userId)))
        return { deletedImages, blockedImages: 0, budgetUsed, drained: false, canceled: false };

      const deleted = await deleteImages(batch);
      deletedImages += deleted.length;
      budgetUsed += batch.length;
    }

    const [state] = await dbWrite.$queryRaw<{ stillDeleted: boolean; hasImages: boolean }[]>`
      SELECT
        EXISTS (SELECT 1 FROM "User" u WHERE u.id = ${userId} AND u."deletedAt" IS NOT NULL) AS "stillDeleted",
        EXISTS (SELECT 1 FROM "Image" i WHERE i."userId" = ${userId}) AS "hasImages"
    `;
    if (!state.stillDeleted || state.hasImages)
      return { deletedImages, blockedImages: 0, budgetUsed, drained: false, canceled: false };

    const posts = await dbWrite.$queryRaw<{ id: number }[]>`
      SELECT id FROM "Post" WHERE "userId" = ${userId}
    `;
    let deletedPosts = 0;
    for (const batch of chunk(
      posts.map((p) => p.id),
      DELETE_BATCH_SIZE
    )) {
      if (isCanceled())
        return { deletedImages, blockedImages: 0, budgetUsed, drained: false, canceled: true };
      deletedPosts += await dbWrite.$executeRaw`
        DELETE FROM "Post"
        WHERE id IN (${Prisma.join(batch)})
          AND "userId" = ${userId}
          AND EXISTS (SELECT 1 FROM "User" u WHERE u.id = ${userId} AND u."deletedAt" IS NOT NULL)
      `;
    }

    // The gated DELETE affecting fewer rows than it targeted means the account came back mid-run.
    return {
      deletedImages,
      blockedImages: 0,
      budgetUsed,
      drained: deletedPosts === posts.length,
      canceled: false,
    };
  } catch (error) {
    return { deletedImages, blockedImages: 0, budgetUsed, drained: false, canceled: false, error };
  }
}

async function blockUserImages(
  userId: number,
  budget: number,
  isCanceled: () => boolean
): Promise<UserDrain> {
  let blockedImages = 0;
  let budgetUsed = 0;

  try {
    const images = await dbWrite.$queryRaw<{ id: number }[]>`
      SELECT i.id
      FROM "Image" i
      JOIN "User" u ON u.id = i."userId" AND u."deletedAt" IS NOT NULL
      WHERE i."userId" = ${userId}
        AND i.ingestion <> 'Blocked'::"ImageIngestionStatus"
      LIMIT ${budget}
    `;

    for (const batch of chunk(
      images.map((i) => i.id),
      DELETE_BATCH_SIZE
    )) {
      if (isCanceled())
        return { deletedImages: 0, blockedImages, budgetUsed, drained: false, canceled: true };

      // Re-blocking an already-blocked image refires the trigger and restarts its 7-day clock,
      // so the predicate has to survive into the UPDATE and not just the fetch above.
      blockedImages += await dbWrite.$executeRaw`
        UPDATE "Image"
        SET ingestion = 'Blocked'::"ImageIngestionStatus",
            "nsfwLevel" = ${NsfwLevel.Blocked},
            "blockedFor" = ${BlockedReason.Moderated}
        WHERE id IN (${Prisma.join(batch)})
          AND "userId" = ${userId}
          AND ingestion <> 'Blocked'::"ImageIngestionStatus"
          AND EXISTS (SELECT 1 FROM "User" u WHERE u.id = ${userId} AND u."deletedAt" IS NOT NULL)
      `;
      budgetUsed += batch.length;
    }

    const [state] = await dbWrite.$queryRaw<{ hasUnblocked: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM "Image" i
        WHERE i."userId" = ${userId} AND i.ingestion <> 'Blocked'::"ImageIngestionStatus"
      ) AS "hasUnblocked"
    `;

    return {
      deletedImages: 0,
      blockedImages,
      budgetUsed,
      drained: !state.hasUnblocked,
      canceled: false,
    };
  } catch (error) {
    return { deletedImages: 0, blockedImages, budgetUsed, drained: false, canceled: false, error };
  }
}

async function drainPage(
  users: Candidate[],
  budget: number,
  isCanceled: () => boolean
): Promise<{
  deletedImages: number;
  blockedImages: number;
  deletedUsers: number;
  remaining: number;
  canceled: boolean;
  drainedThrough?: Date;
}> {
  let remaining = budget;
  let deletedImages = 0;
  let blockedImages = 0;
  let deletedUsers = 0;
  let canceled = false;
  let drainedThrough: Date | undefined;
  // A user left half-drained (by the budget, a cancel, or an error) has to be reached again
  // next run, so the cursor stops at the first one it did not finish rather than at the last
  // one it did.
  let stalled = false;

  for (const user of users) {
    if (remaining <= 0) break;
    if (isCanceled()) {
      canceled = true;
      break;
    }

    const result =
      user.mode === 'grace'
        ? await blockUserImages(user.id, remaining, isCanceled)
        : await drainUser(user.id, remaining, isCanceled);
    remaining -= result.budgetUsed;
    deletedImages += result.deletedImages;
    blockedImages += result.blockedImages;
    canceled = result.canceled;

    if (result.error)
      await logToAxiom({
        type: 'error',
        name: 'remove-deleted-user-images',
        message: (result.error as Error).message,
        error: safeError(result.error),
        userId: user.id,
      }).catch(() => undefined);

    if (result.drained) {
      deletedUsers += 1;
      if (!stalled) drainedThrough = user.deletedAt;
    } else stalled = true;

    if (canceled) break;
  }

  return { deletedImages, blockedImages, deletedUsers, remaining, canceled, drainedThrough };
}

export const removeDeletedUserImages = createJob(
  'remove-deleted-user-images',
  '15 * * * *',
  async (ctx) => {
    const budget = await getImagePurgeBudget();
    if (budget <= 0) return { paused: true, deletedImages: 0, blockedImages: 0, deletedUsers: 0 };

    // A cancel is a clean stop, not a failure; converting the throw keeps it out of both the
    // per-user error log and the job runner's error counter.
    const isCanceled = () => {
      try {
        ctx.checkIfCanceled();
        return false;
      } catch {
        return true;
      }
    };

    const [freshMark, setFreshMark] = await getJobDate(FRESH_CURSOR_KEY, new Date());
    const [backlogCursor, setBacklogCursor] = await getJobDate(BACKLOG_CURSOR_KEY, CURSOR_START);

    // Both bounds are inclusive of their own timestamp: a bulk or admin delete stamps one
    // `now()` across many accounts, and the worklist already drops accounts that no longer own
    // anything, so re-reading the tie costs nothing and is the only way not to skip the rest.

    // A grace user has outstanding work only while they still own an unblocked image: their
    // posts leave with the images at day 7, via CleanIfEmpty, not from here.
    const fresh = await dbRead.$queryRaw<Candidate[]>`
      SELECT u.id, u."deletedAt",
             COALESCE(u.meta->>'imageRemoval', 'immediate') AS mode
      FROM "User" u
      WHERE u."deletedAt" IS NOT NULL
        AND u."deletedAt" >= ${freshMark}
        AND (
          EXISTS (
            SELECT 1 FROM "Image" i
            WHERE i."userId" = u.id AND i.ingestion <> 'Blocked'::"ImageIngestionStatus"
          )
          OR (
            COALESCE(u.meta->>'imageRemoval', 'immediate') <> 'grace'
            AND EXISTS (SELECT 1 FROM "Post" p WHERE p."userId" = u.id)
          )
        )
      ORDER BY u."deletedAt" ASC
      LIMIT ${USERS_PER_RUN}
    `;

    const freshRun = await drainPage(fresh, budget, isCanceled);
    // Written on every run, drained or not: an unstored key falls back to the default, so a
    // first run that never persists its seed re-seeds to a later `now` on the next tick and
    // everything deleted in between lands above the mark and below the backlog cursor.
    await setFreshMark(freshRun.drainedThrough ?? freshMark);

    let deletedImages = freshRun.deletedImages;
    let blockedImages = freshRun.blockedImages;
    let deletedUsers = freshRun.deletedUsers;
    let candidates = fresh.length;
    let wrapped = false;

    if (freshRun.remaining > 0 && !freshRun.canceled) {
      const backlog = await dbRead.$queryRaw<Candidate[]>`
        SELECT u.id, u."deletedAt",
               COALESCE(u.meta->>'imageRemoval', 'immediate') AS mode
        FROM "User" u
        WHERE u."deletedAt" IS NOT NULL
          AND u."deletedAt" <= ${backlogCursor}
          AND u."deletedAt" < ${freshMark}
          AND (
            EXISTS (
              SELECT 1 FROM "Image" i
              WHERE i."userId" = u.id AND i.ingestion <> 'Blocked'::"ImageIngestionStatus"
            )
            OR (
              COALESCE(u.meta->>'imageRemoval', 'immediate') <> 'grace'
              AND EXISTS (SELECT 1 FROM "Post" p WHERE p."userId" = u.id)
            )
          )
        ORDER BY u."deletedAt" DESC
        LIMIT ${USERS_PER_RUN}
      `;

      if (!backlog.length) {
        wrapped = true;
        await setBacklogCursor(CURSOR_START);
      } else {
        const backlogRun = await drainPage(backlog, freshRun.remaining, isCanceled);
        deletedImages += backlogRun.deletedImages;
        blockedImages += backlogRun.blockedImages;
        deletedUsers += backlogRun.deletedUsers;
        candidates += backlog.length;
        if (backlogRun.drainedThrough) await setBacklogCursor(backlogRun.drainedThrough);
      }
    }

    await logToAxiom({
      type: 'info',
      name: 'remove-deleted-user-images',
      deletedImages,
      blockedImages,
      deletedUsers,
      freshDeletedImages: freshRun.deletedImages,
      freshDeletedUsers: freshRun.deletedUsers,
      candidates,
      budget,
    }).catch(() => undefined);

    return { deletedImages, blockedImages, deletedUsers, wrapped };
  },
  { lockExpiration: 30 * 60, dedicated: true }
);
