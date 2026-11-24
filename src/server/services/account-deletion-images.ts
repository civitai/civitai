import { childSafetyImageCase, childSafetyPostCase } from '@civitai/db-queries/child-safety-case';
import { uniq } from 'lodash-es';
import { toPrismaSql } from '~/server/db/prisma-sql-kysely';
import { EntityType, JobQueueType } from '~/shared/utils/prisma/enums';
import { BlockedReason, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  queueImageSearchIndexUpdate,
  resetBlockedNsfwLevel,
  dropBlockedImageDeleteQueue,
} from '~/server/services/image.service';
import { bustCachesForPosts } from '~/server/services/post.service';
import { decodeRedisString } from '~/server/redis/buffer-decode';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { IMAGE_REVIEW_PRECEDENCE, RESTORABLE_REVIEWS } from '@civitai/shared/image-review-types';
import { getPendingAppealImageIds } from '~/server/services/image-appeal-flag';
import {
  PRIOR_BLOCKED_FOR_KEY,
  PRIOR_INGESTION_KEY,
  PRIOR_NEEDS_REVIEW_KEY,
} from '~/server/utils/image-removal-mode';

export const RESTORE_BATCH_SIZE = 500;
const RESTORE_FOLLOWUP_CONCURRENCY = 2;

/**
 * A claimed row loses the breadcrumb its own claim requires, so the loop drains on its own. This
 * only bounds the case where a row is claimed and comes back unchanged, which would otherwise
 * re-claim the same batch forever; 500 x 5000 is well clear of the largest gallery (~785K).
 */
export const MAX_RESTORE_BATCHES = 5000;

/**
 * Drops the 7-day purge `remove-deleted-user-images` armed for this account. That job reads
 * nothing but `JobQueue` — no owner and no `deletedAt` predicate — so until these rows are gone
 * a restored account is still counting down to losing every image row and S3 object.
 *
 * Returns a `PrismaPromise` so the caller can land it in the same transaction as the
 * `deletedAt` clear: a gap between the two is a window where a crash leaves the purge armed on
 * an account that is once again live.
 */
export function disarmAccountDeletionImagePurge(userId: number) {
  return dbWrite.$executeRaw`
    DELETE FROM "JobQueue"
    WHERE type = ${JobQueueType.BlockedImageDelete}::"JobQueueType"
      AND "entityType" = ${EntityType.Image}::"EntityType"
      AND "entityId" IN (SELECT i.id FROM "Image" i WHERE i."userId" = ${userId})
  `;
}

/**
 * Takes the drain's ask off this account's pending deletes, which `pending-deletes` carries out
 * without looking at the account: a row only it asked for goes, and one someone else also asked for
 * keeps theirs. One whose case is still open stays, marked `releasedOnRestore`, so the restore cannot
 * make it publishable and `pending-deletes` releases rather than deletes it once the case closes. A `PrismaPromise`, for the same transaction as the `deletedAt` clear.
 */
export function releaseAccountDeletionPendingDeletes(userId: number) {
  return dbWrite.$executeRaw`
    WITH drained AS (
      SELECT q."entityType", q."entityId", q.data ?| array['ownerId', 'cleanup'] AS "askedElse",
        CASE WHEN q."entityType" = 'Image'
          THEN EXISTS (SELECT 1 FROM "Image" WHERE "Image".id = q."entityId" AND ${toPrismaSql(
            childSafetyImageCase()
          )})
          ELSE EXISTS (SELECT 1 FROM "Post" WHERE "Post".id = q."entityId" AND ${toPrismaSql(
            childSafetyPostCase()
          )})
        END AS "inCase"
      FROM "JobQueue" q
      WHERE q.type = 'PendingDelete'::"JobQueueType" AND q.data->>'deletedBy' = ${ACCOUNT_DELETION_DRAIN}
        AND (
          (q."entityType" = 'Image' AND q."entityId" IN (SELECT id FROM "Image" WHERE "userId" = ${userId}))
          OR (q."entityType" = 'Post' AND q."entityId" IN (SELECT id FROM "Post" WHERE "userId" = ${userId}))
        )
    ),
    stripped AS (
      UPDATE "JobQueue" q SET data = q.data - 'deletedBy' FROM drained d
      WHERE q.type = 'PendingDelete'::"JobQueueType" AND q."entityType" = d."entityType"
        AND q."entityId" = d."entityId" AND d."askedElse"
    ),
    -- Its case keeps it hidden; once the case closes, pending-deletes drops the row instead of deleting.
    marked AS (
      UPDATE "JobQueue" q SET data = q.data || '{"releasedOnRestore": true}'::jsonb FROM drained d
      WHERE q.type = 'PendingDelete'::"JobQueueType" AND q."entityType" = d."entityType"
        AND q."entityId" = d."entityId" AND NOT d."askedElse" AND d."inCase"
    )
    DELETE FROM "JobQueue" q USING drained d
    WHERE q.type = 'PendingDelete'::"JobQueueType" AND q."entityType" = d."entityType"
      AND q."entityId" = d."entityId" AND NOT d."askedElse" AND NOT d."inCase"
  `;
}

/** The actor `remove-deleted-user-images` deletes as, which its queued deletes name. */
export const ACCOUNT_DELETION_DRAIN = 'remove-deleted-user-images';

/**
 * Undoes the grace block, keyed off the `Image.metadata` breadcrumbs the block wrote rather than
 * off `blockedFor`: a moderator block is also `blockedFor = 'moderated'`, so anything scoped that
 * way would unblock content a moderator hid. Restoring the recorded values rather than forcing
 * `Scanned`/`NULL` keeps an image that was mid-scan (or blocked for `AiNotVerified`) in the state
 * it was actually in. The exception is a CSAM reason, current or recorded: it is kept, and the row
 * stays `Blocked`.
 *
 * Each claim re-checks that the owner is neither deleted nor banned, so either landing mid-reversal
 * stops it at the next pass.
 *
 * The largest account holds ~785K images, so the reversal claims a bounded batch per pass instead
 * of returning the whole gallery to Node in one statement. The breadcrumb check lives in the claim
 * rather than in the UPDATE's own `WHERE`: a row the enum cast would reject has to be left
 * unclaimed, or every pass would re-claim it and never strip it.
 */
export async function unblockAccountDeletionImages(userId: number) {
  let unblocked = 0;
  let stillBlocked = 0;
  let passes = 0;
  let drained = false;

  while (passes < MAX_RESTORE_BATCHES) {
    passes++;
    const restored = await dbWrite.$queryRaw<
      {
        id: number;
        postId: number | null;
        ingestion: string;
        blockedFor: string | null;
        needsReview: string | null;
        currentReview: string | null;
        recordedReview: string | null;
      }[]
    >`
      UPDATE "Image"
      SET ingestion = CASE
            WHEN "blockedFor" = ${BlockedReason.CSAM} OR "metadata"->>${PRIOR_BLOCKED_FOR_KEY}::text = ${BlockedReason.CSAM}
            THEN 'Blocked'::"ImageIngestionStatus"
            ELSE ("metadata"->>${PRIOR_INGESTION_KEY}::text)::"ImageIngestionStatus"
          END,
          "blockedFor" = CASE
            WHEN "blockedFor" = ${BlockedReason.CSAM} THEN "blockedFor"
            ELSE "metadata"->>${PRIOR_BLOCKED_FOR_KEY}::text
          END,
          -- The one column holds one review: of the current flag and the recorded one, the higher in
          -- IMAGE_REVIEW_PRECEDENCE stays. A current 'csam' is never overwritten, and a recorded value
          -- outside RESTORABLE_REVIEWS (a recorded 'csam', or a forged one) writes nothing.
          "needsReview" = CASE
            WHEN "needsReview" = 'csam' THEN "needsReview"
            WHEN c."recordedReview" IS NULL
              OR NOT (c."recordedReview" = ANY(${RESTORABLE_REVIEWS}::text[]))
            THEN "needsReview"
            WHEN "needsReview" IS NULL THEN c."recordedReview"
            WHEN array_position(${IMAGE_REVIEW_PRECEDENCE}::text[], "needsReview")
              <= array_position(${IMAGE_REVIEW_PRECEDENCE}::text[], c."recordedReview")
            THEN "needsReview"
            ELSE c."recordedReview"
          END,
          "metadata" = "metadata" - ${PRIOR_INGESTION_KEY}::text - ${PRIOR_BLOCKED_FOR_KEY}::text - ${PRIOR_NEEDS_REVIEW_KEY}::text
      FROM (
        SELECT i.id, i."needsReview" AS "currentReview",
          -- A recorded appeal decided during the window has no queue left to clear it.
          CASE
            WHEN i."metadata"->>${PRIOR_NEEDS_REVIEW_KEY}::text = 'appeal' AND NOT EXISTS (
              SELECT 1 FROM "Appeal" a
              WHERE a."entityType" = 'Image'::"EntityType"
                AND a."entityId" = i.id
                AND a.status = 'Pending'::"AppealStatus"
            ) THEN NULL
            ELSE i."metadata"->>${PRIOR_NEEDS_REVIEW_KEY}::text
          END AS "recordedReview"
        FROM "Image" i
        WHERE i."userId" = ${userId}
          AND i.ingestion = 'Blocked'::"ImageIngestionStatus"
          AND i."metadata"->>${PRIOR_INGESTION_KEY}::text IS NOT NULL
          AND i."metadata"->>${PRIOR_INGESTION_KEY}::text IN (SELECT unnest(enum_range(NULL::"ImageIngestionStatus"))::text)
          AND (SELECT COALESCE(u."deletedAt", u."bannedAt") IS NULL FROM "User" u WHERE u.id = ${userId})
        LIMIT ${RESTORE_BATCH_SIZE}
      ) c
      WHERE "Image".id = c.id
      RETURNING "Image".id, "postId", ingestion, "blockedFor", "needsReview", c."currentReview", c."recordedReview"
    `;

    if (!restored.length) {
      drained = true;
      break;
    }

    const competing = restored.flatMap(({ id, needsReview, currentReview, recordedReview }) => {
      if (!currentReview || !recordedReview || currentReview === recordedReview) return [];
      if (!(RESTORABLE_REVIEWS as readonly string[]).includes(recordedReview)) return [];
      const dropped = needsReview === currentReview ? recordedReview : currentReview;
      return [{ imageId: id, kept: needsReview, dropped }];
    });
    if (competing.length) {
      // An appeal outranked here leaves the appeals queue while its Appeal stays Pending.
      const pendingAppeals = await getPendingAppealImageIds(
        competing.filter((review) => review.dropped === 'appeal').map((review) => review.imageId)
      );
      logToAxiom({
        type: 'warning',
        name: 'account-deletion-image-restore',
        message: 'kept the higher of two competing review flags',
        payload: {
          reviews: competing.map((review) =>
            pendingAppeals.has(review.imageId) ? { ...review, pendingAppeal: true } : review
          ),
        },
      });
    }

    const visible = restored.filter(
      (x) => x.ingestion !== 'Blocked' && x.blockedFor !== BlockedReason.CSAM
    );
    const ids = visible.map((x) => x.id);
    const postIds = uniq(visible.map((x) => x.postId).filter((id): id is number => id != null));
    unblocked += ids.length;
    stillBlocked += restored.length - ids.length;

    if (ids.length)
      await limitConcurrency(
        [
          // Blocking force-set `nsfwLevel` to Blocked and left the rating lock on, which the
          // recompute skips; resetBlockedNsfwLevel is the shared undo for that.
          () => resetBlockedNsfwLevel(ids),
          // The grace block queued these for purge; leaving the row behind means a later
          // re-delete inherits the first block's clock and skips retention entirely.
          () => dropBlockedImageDeleteQueue(ids),
          () => queueImageSearchIndexUpdate({ ids, action: SearchIndexUpdateQueueAction.Update }),
        ],
        RESTORE_FOLLOWUP_CONCURRENCY
      );
    // Sequenced after the reset, not folded into it: a read racing the bust would otherwise
    // re-cache the Blocked level the reset is in the middle of clearing.
    if (postIds.length) await bustCachesForPosts(postIds);
  }

  const [audit] = await dbWrite.$queryRaw<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM "Image"
    WHERE "userId" = ${userId}
      AND ingestion = 'Blocked'::"ImageIngestionStatus"
      AND "metadata"->>${PRIOR_INGESTION_KEY}::text IS NOT NULL
      AND "metadata"->>${PRIOR_INGESTION_KEY}::text NOT IN (SELECT unnest(enum_range(NULL::"ImageIngestionStatus"))::text)
  `;
  const skipped = audit?.count ?? 0;

  if (skipped > 0 || !drained)
    logToAxiom({
      type: 'warning',
      name: 'account-deletion-image-restore',
      message: drained
        ? 'left images blocked with an unreadable ingestion breadcrumb'
        : 'stopped at the batch ceiling with images still blocked',
      userId,
      unblocked,
      stillBlocked,
      skipped,
      drained,
      passes,
    });

  return { unblocked, stillBlocked, skipped, drained };
}

export async function countPendingAccountDeletionImageRestores(userId: number) {
  const [row] = await dbWrite.$queryRaw<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM "Image"
    WHERE "userId" = ${userId}
      AND ingestion = 'Blocked'::"ImageIngestionStatus"
      AND "metadata"->>${PRIOR_INGESTION_KEY}::text IS NOT NULL
  `;
  return row?.count ?? 0;
}

/**
 * Names an account for `restore-user-images` instead of leaving the job to find it. A failure
 * costs the images their automatic return, not the restore — which has already committed, and
 * which a moderator cannot retry because the account no longer reads as deleted — so it is logged
 * rather than thrown, and the breadcrumbs still say what to undo.
 */
export async function recordPendingImageRestore(userId: number) {
  try {
    await sysRedis.sAdd(REDIS_SYS_KEYS.SYSTEM.PENDING_IMAGE_RESTORES, String(userId));
    return true;
  } catch (error) {
    logToAxiom({
      type: 'error',
      name: 'account-deletion-image-restore',
      message: 'could not queue the account for image restore',
      error: (error as Error)?.message,
      userId,
    });
    return false;
  }
}

export async function readPendingImageRestores() {
  const members = await sysRedis.sMembers(REDIS_SYS_KEYS.SYSTEM.PENDING_IMAGE_RESTORES);
  return (members ?? [])
    .map((member) => Number(decodeRedisString(member)))
    .filter((userId) => Number.isInteger(userId));
}

export async function clearPendingImageRestore(userId: number) {
  await sysRedis.sRem(REDIS_SYS_KEYS.SYSTEM.PENDING_IMAGE_RESTORES, String(userId));
}
