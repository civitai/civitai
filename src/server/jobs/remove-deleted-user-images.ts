import { Prisma } from '@prisma/client';
import { chunk, uniq } from 'lodash-es';
import { BlockedReason, NsfwLevel, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom, safeError } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import {
  deleteImages,
  invalidateManyImageExistence,
  queueImageSearchIndexUpdate,
} from '~/server/services/image.service';
import { bustCachesForPosts } from '~/server/services/post.service';
import { PRIOR_BLOCKED_FOR_KEY, PRIOR_INGESTION_KEY } from '~/server/utils/image-removal-mode';
import { createJob, getJobDate } from './job';

export const USERS_PER_RUN = 50;
export const DELETE_BATCH_SIZE = 100;

/**
 * Inert on purpose: this drain hard-deletes image rows and their S3 objects, so a limit key that
 * is missing or unreadable has to stop the job rather than run it at some compiled-in rate.
 * Enabling the drain is the deliberate act — an operator sets a positive limit.
 */
export const DEFAULT_IMAGES_PER_RUN = 0;

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

type TouchedImage = { id: number; postId: number | null };

async function isStillDeleted(userId: number) {
  const [row] = await dbWrite.$queryRaw<{ stillDeleted: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM "User" u WHERE u.id = ${userId} AND u."deletedAt" IS NOT NULL
    ) AS "stillDeleted"
  `;
  return row.stillDeleted;
}

/**
 * The choice is read off a replica by the worklist while every gate on the destructive path is
 * read off the primary. Re-reading it here — and on every gate below — makes a stale read resolve
 * to the branch that keeps the images rather than the one that destroys them.
 */
async function isStillMarkedForDeletion(userId: number) {
  const [row] = await dbWrite.$queryRaw<{ stillDeleted: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM "User" u
      WHERE u.id = ${userId}
        AND u."deletedAt" IS NOT NULL
        AND (u.meta->>'imageRemoval' IS NULL OR u.meta->>'imageRemoval' = 'immediate')
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
      JOIN "User" u ON u.id = i."userId"
        AND u."deletedAt" IS NOT NULL
        AND (u.meta->>'imageRemoval' IS NULL OR u.meta->>'imageRemoval' = 'immediate')
      WHERE i."userId" = ${userId}
        AND NOT EXISTS (
          SELECT 1 FROM "CsamReport" c
          WHERE c."userId" = ${userId}
            AND (c."reportSentAt" IS NULL OR c."archivedAt" IS NULL)
        )
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
      if (!(await isStillMarkedForDeletion(userId)))
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
          AND EXISTS (
            SELECT 1 FROM "User" u
            WHERE u.id = ${userId}
              AND u."deletedAt" IS NOT NULL
              AND (u.meta->>'imageRemoval' IS NULL OR u.meta->>'imageRemoval' = 'immediate')
          )
          AND NOT EXISTS (
            SELECT 1 FROM "CsamReport" c
            WHERE c."userId" = ${userId}
              AND (c."reportSentAt" IS NULL OR c."archivedAt" IS NULL)
          )
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

/**
 * A bare UPDATE leaves the row in the incremental index, which pulls on `ingestion = 'Scanned'`
 * and so skips a blocked row rather than removing it — the image stays findable in site search
 * until a full reindex. Mirrors `handleBlockImages`.
 */
async function propagateBlock(touched: TouchedImage[]) {
  if (!touched.length) return;
  const ids = touched.map((x) => x.id);
  const postIds = uniq(touched.map((x) => x.postId).filter((id): id is number => id != null));

  await Promise.all([
    queueImageSearchIndexUpdate({ ids, action: SearchIndexUpdateQueueAction.Delete }),
    invalidateManyImageExistence(ids),
  ]);
  if (postIds.length) await bustCachesForPosts(postIds);
}

/**
 * `trg_blocked_image_delete_queue` only fires on an `ingestion` transition, so the rows this pass
 * re-pointed off `AiNotVerified` carry no queue row — and neither do rows blocked in the week the
 * trigger migration's backfill deliberately excluded. `remove-blocked-images` reads nothing but
 * the queue, so without this they are retained forever on an account that asked to be deleted.
 */
async function queueBlockedImagesForDelete(userId: number) {
  await dbWrite.$executeRaw`
    INSERT INTO "JobQueue" ("entityId", "entityType", "type")
    SELECT i.id, 'Image'::"EntityType", 'BlockedImageDelete'::"JobQueueType"
    FROM "Image" i
    WHERE i."userId" = ${userId}
      AND i.ingestion = 'Blocked'::"ImageIngestionStatus"
      AND i."blockedFor" IS DISTINCT FROM ${BlockedReason.AiNotVerified}
      AND EXISTS (SELECT 1 FROM "User" u WHERE u.id = ${userId} AND u."deletedAt" IS NOT NULL)
    ON CONFLICT DO NOTHING
  `;
}

/**
 * No statement-level CSAM gate here, unlike `drainUser`: blocking never touches S3, and the NCMEC
 * archive re-fetches from the CDN, which still serves a blocked image.
 */
async function blockUserImages(
  userId: number,
  budget: number,
  isCanceled: () => boolean
): Promise<UserDrain> {
  let blockedImages = 0;
  let budgetUsed = 0;

  try {
    const images = await dbWrite.$queryRaw<{ id: number; wasBlocked: boolean }[]>`
      SELECT i.id, i.ingestion = 'Blocked'::"ImageIngestionStatus" AS "wasBlocked"
      FROM "Image" i
      JOIN "User" u ON u.id = i."userId" AND u."deletedAt" IS NOT NULL
      WHERE i."userId" = ${userId}
        AND (
          i.ingestion <> 'Blocked'::"ImageIngestionStatus"
          OR i."blockedFor" = ${BlockedReason.AiNotVerified}
        )
      LIMIT ${budget}
    `;

    for (const batch of chunk(images, DELETE_BATCH_SIZE)) {
      if (isCanceled())
        return { deletedImages: 0, blockedImages, budgetUsed, drained: false, canceled: true };
      // The gate on the UPDATE keeps a restore from being written over; this keeps the run from
      // charging its whole budget to statements that now affect nothing.
      if (!(await isStillDeleted(userId)))
        return { deletedImages: 0, blockedImages, budgetUsed, drained: false, canceled: false };

      const hide = batch.filter((i) => !i.wasBlocked).map((i) => i.id);
      const repoint = batch.filter((i) => i.wasBlocked).map((i) => i.id);
      const touched: TouchedImage[] = [];

      if (hide.length) {
        // `@updatedAt` is stamped by the Prisma client, so raw SQL has to set it — and it is the
        // clock remove-blocked-images counts the `moderated` retention window from, so restamping
        // an already-blocked row would push its purge out another 7 days.
        touched.push(
          ...(await dbWrite.$queryRaw<TouchedImage[]>`
            UPDATE "Image"
            SET ingestion = 'Blocked'::"ImageIngestionStatus",
                "nsfwLevel" = ${NsfwLevel.Blocked},
                "blockedFor" = ${BlockedReason.Moderated},
                "needsReview" = NULL,
                "metadata" = "metadata" || jsonb_build_object(${PRIOR_INGESTION_KEY}::text, ingestion::text),
                "updatedAt" = now()
            WHERE id IN (${Prisma.join(hide)})
              AND "userId" = ${userId}
              AND ingestion <> 'Blocked'::"ImageIngestionStatus"
              AND EXISTS (SELECT 1 FROM "User" u WHERE u.id = ${userId} AND u."deletedAt" IS NOT NULL)
            RETURNING id, "postId"
          `)
        );
      }

      if (repoint.length) {
        // remove-blocked-images refuses `AiNotVerified` and evicts its queue rows as stale, so a
        // grace account would keep these forever while an immediate one deletes them.
        touched.push(
          ...(await dbWrite.$queryRaw<TouchedImage[]>`
            UPDATE "Image"
            SET "blockedFor" = ${BlockedReason.Moderated},
                "metadata" = "metadata" || jsonb_build_object(${PRIOR_INGESTION_KEY}::text, ingestion::text, ${PRIOR_BLOCKED_FOR_KEY}::text, "blockedFor"),
                "updatedAt" = now()
            WHERE id IN (${Prisma.join(repoint)})
              AND "userId" = ${userId}
              AND ingestion = 'Blocked'::"ImageIngestionStatus"
              AND "blockedFor" = ${BlockedReason.AiNotVerified}
              AND EXISTS (SELECT 1 FROM "User" u WHERE u.id = ${userId} AND u."deletedAt" IS NOT NULL)
            RETURNING id, "postId"
          `)
        );
      }

      blockedImages += touched.length;
      budgetUsed += batch.length;
      await propagateBlock(touched);
    }

    const [state] = await dbWrite.$queryRaw<{ hasPending: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM "Image" i
        WHERE i."userId" = ${userId}
          AND (
            i.ingestion <> 'Blocked'::"ImageIngestionStatus"
            OR i."blockedFor" = ${BlockedReason.AiNotVerified}
          )
      ) AS "hasPending"
    `;

    if (!state.hasPending) await queueBlockedImagesForDelete(userId);

    return {
      deletedImages: 0,
      blockedImages,
      budgetUsed,
      drained: !state.hasPending,
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

    // Dispatched on 'immediate' rather than on 'grace' so that anything the worklist failed to
    // resolve — a mode it did not select, a value it did not normalize — blocks instead of deletes.
    const result =
      user.mode === 'immediate'
        ? await drainUser(user.id, remaining, isCanceled)
        : await blockUserImages(user.id, remaining, isCanceled);
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

    // An absent or 'immediate' choice resolves to deletion and anything else to grace: a value
    // we cannot read should cost storage rather than the images. A grace user then has work only
    // while they own an image the purge pipeline would not take — their posts leave at day 7 with
    // CleanIfEmpty — while an immediate user still matches on any image, or an account left
    // holding only blocked ones would drop out of the worklist with nothing else to sweep it.

    // An account with an unfinished CSAM report is left out entirely: archive-csam-reports runs
    // five minutes after this job and rebuilds the NCMEC evidence by re-fetching each image from
    // the CDN, silently skipping — and then stamping the report archived — for anything gone.
    const fresh = await dbRead.$queryRaw<Candidate[]>`
      SELECT u.id, u."deletedAt", m.mode
      FROM "User" u
      CROSS JOIN LATERAL (
        SELECT CASE
          WHEN u.meta->>'imageRemoval' IS NULL OR u.meta->>'imageRemoval' = 'immediate'
          THEN 'immediate' ELSE 'grace'
        END AS mode
      ) m
      WHERE u."deletedAt" IS NOT NULL
        AND u."deletedAt" >= ${freshMark}
        AND NOT EXISTS (
          SELECT 1 FROM "CsamReport" c
          WHERE c."userId" = u.id
            AND (c."reportSentAt" IS NULL OR c."archivedAt" IS NULL)
        )
        AND (
          EXISTS (
            SELECT 1 FROM "Image" i
            WHERE i."userId" = u.id
              AND (
                m.mode = 'immediate'
                OR i.ingestion <> 'Blocked'::"ImageIngestionStatus"
                OR i."blockedFor" = ${BlockedReason.AiNotVerified}
              )
          )
          OR (m.mode = 'immediate' AND EXISTS (SELECT 1 FROM "Post" p WHERE p."userId" = u.id))
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
        SELECT u.id, u."deletedAt", m.mode
        FROM "User" u
        CROSS JOIN LATERAL (
          SELECT CASE
            WHEN u.meta->>'imageRemoval' IS NULL OR u.meta->>'imageRemoval' = 'immediate'
            THEN 'immediate' ELSE 'grace'
          END AS mode
        ) m
        WHERE u."deletedAt" IS NOT NULL
          AND u."deletedAt" <= ${backlogCursor}
          AND u."deletedAt" < ${freshMark}
          AND NOT EXISTS (
            SELECT 1 FROM "CsamReport" c
            WHERE c."userId" = u.id
              AND (c."reportSentAt" IS NULL OR c."archivedAt" IS NULL)
          )
          AND (
            EXISTS (
              SELECT 1 FROM "Image" i
              WHERE i."userId" = u.id
                AND (
                  m.mode = 'immediate'
                  OR i.ingestion <> 'Blocked'::"ImageIngestionStatus"
                  OR i."blockedFor" = ${BlockedReason.AiNotVerified}
                )
            )
            OR (m.mode = 'immediate' AND EXISTS (SELECT 1 FROM "Post" p WHERE p."userId" = u.id))
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
