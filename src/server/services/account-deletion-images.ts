import {
  childSafetyImageCase,
  childSafetyImageFinding,
  childSafetyPostCase,
  childSafetyPostFinding,
} from '@civitai/db-queries/child-safety-case';
import {
  liftKeptHides,
  lockForLift,
  selectLifted,
  type LiftedRow,
} from '@civitai/db-queries/content-deletion';
import { sql } from 'kysely';
import { uniq } from 'lodash-es';
import { toPrismaSql } from '~/server/db/prisma-sql-kysely';
import { EntityType, JobQueueType } from '~/shared/utils/prisma/enums';
import { BlockedReason, NsfwLevel, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  queueImageSearchIndexUpdate,
  refreshImageLevelCaches,
  resetBlockedNsfwLevel,
  dropBlockedImageDeleteQueue,
} from '~/server/services/image.service';
import { bustCachesForPosts } from '~/server/services/post.service';
import { decodeRedisString } from '~/server/redis/buffer-decode';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { IMAGE_REVIEW_PRECEDENCE, RESTORABLE_REVIEWS } from '@civitai/shared/image-review-types';
import { getPendingAppealImageIds } from '~/server/services/image-appeal-flag';
import { csamBlockedSql, pendingImageAppealSql } from '~/server/common/image-visibility';
import { Prisma } from '@prisma/client';
import { moderatorWithheldSql } from '@civitai/shared/retracted-media-tier';
import {
  PRIOR_BLOCKED_FOR_KEY,
  PRIOR_INGESTION_KEY,
  PRIOR_NEEDS_REVIEW_KEY,
  PRIOR_NSFW_LEVEL_KEY,
  PRIOR_NSFW_LOCKED_KEY,
  minusPriorKeysSql,
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
 * Only for images that still carry the grace breadcrumb: a block written during the grace period
 * strips it and keeps its own purge row. Run this before anything clears breadcrumbs, or the grace
 * purge stays armed.
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
      AND "entityId" IN (
        SELECT i.id FROM "Image" i
        WHERE i."userId" = ${userId} AND (i."metadata" -> ${PRIOR_INGESTION_KEY}::text) IS NOT NULL
      )
  `;
}

/**
 * Locks this account's items the drain queued, for `releaseAccountDeletionPendingDeletes` to read in a
 * later statement of the same transaction (`lockForLift`). A `PrismaPromise`.
 */
export function lockAccountDeletionPendingDeletes(userId: number) {
  const queued = (entityType: 'Image' | 'Post') => sql`SELECT q."entityId" FROM "JobQueue" q
    WHERE q.type = 'PendingDelete' AND q."entityType" = ${entityType}::"EntityType"
      AND q.data->>'deletedBy' = ${ACCOUNT_DELETION_DRAIN}
      AND q."entityId" IN (SELECT id FROM ${sql.table(entityType)} WHERE "userId" = ${userId})`;
  return dbWrite.$executeRaw`
    WITH images AS (${toPrismaSql(lockForLift('Image', queued('Image')))}),
      posts AS (${toPrismaSql(lockForLift('Post', queued('Post')))})
    SELECT (SELECT count(*) FROM images) + (SELECT count(*) FROM posts) AS locked`;
}

/**
 * Takes the drain's ask off this account's pending deletes, which `pending-deletes` carries out
 * without looking at the account: a row only it asked for goes, and one someone else also asked for
 * keeps theirs. One whose case is still open, or closed with a finding the delete has not yet acted
 * on, stays, marked `releasedOnRestore`, so the restore cannot
 * make it publishable; `pending-deletes` releases it once the case closes with no finding, and
 * deletes it otherwise. While any of the account's is in an open case, every one only the drain
 * asked for is marked, so they are released together once the last closes (`restoreCaseOpen`).
 * A row released outright gets back what the drain's kept-delete hide took (`liftKeptHides`); the
 * result names what was lifted, for `refreshLiftedKeptHides` once the transaction commits.
 * A `PrismaPromise`, for the same transaction as the `deletedAt` clear.
 */
export function releaseAccountDeletionPendingDeletes(userId: number) {
  return dbWrite.$queryRaw<LiftedRow[]>`
    WITH drained AS (
      SELECT q."entityType", q."entityId", q.data ?| array['ownerId', 'cleanup'] AS "askedElse",
        CASE WHEN q."entityType" = 'Image'
          THEN EXISTS (SELECT 1 FROM "Image" WHERE "Image".id = q."entityId" AND (${toPrismaSql(
            childSafetyImageCase()
          )} OR ${toPrismaSql(childSafetyImageFinding())} IS NOT FALSE))
          ELSE EXISTS (SELECT 1 FROM "Post" WHERE "Post".id = q."entityId" AND (${toPrismaSql(
            childSafetyPostCase()
          )} OR ${toPrismaSql(childSafetyPostFinding())} IS NOT FALSE))
        END AS "inCase",
        CASE WHEN q."entityType" = 'Image'
          THEN EXISTS (SELECT 1 FROM "Image" WHERE "Image".id = q."entityId" AND ${toPrismaSql(
            childSafetyImageCase()
          )})
          ELSE EXISTS (SELECT 1 FROM "Post" WHERE "Post".id = q."entityId" AND ${toPrismaSql(
            childSafetyPostCase()
          )})
        END AS "openCase"
      FROM "JobQueue" q
      WHERE q.type = 'PendingDelete'::"JobQueueType" AND q.data->>'deletedBy' = ${ACCOUNT_DELETION_DRAIN}
        AND (
          (q."entityType" = 'Image' AND q."entityId" IN (SELECT id FROM "Image" WHERE "userId" = ${userId}))
          OR (q."entityType" = 'Post' AND q."entityId" IN (SELECT id FROM "Post" WHERE "userId" = ${userId}))
        )
    ),
    -- While any of them is in an open case, none is released: they all wait for the last to close.
    waits AS (SELECT EXISTS (SELECT 1 FROM drained WHERE "openCase") AS "all"),
    stripped AS (
      UPDATE "JobQueue" q SET data = q.data - 'deletedBy' FROM drained d
      WHERE q.type = 'PendingDelete'::"JobQueueType" AND q."entityType" = d."entityType"
        AND q."entityId" = d."entityId" AND d."askedElse"
    ),
    -- Kept, hidden, while its case is open or has a finding, or another of them waits: pending-deletes
    -- decides it, releasing it only on a no-finding close when no other ask has replaced the drain's.
    marked AS (
      UPDATE "JobQueue" q SET data = q.data || '{"releasedOnRestore": true}'::jsonb FROM drained d, waits w
      WHERE q.type = 'PendingDelete'::"JobQueueType" AND q."entityType" = d."entityType"
        AND q."entityId" = d."entityId" AND NOT d."askedElse" AND (d."inCase" OR w."all")
    ),
    released AS (
      DELETE FROM "JobQueue" q USING drained d, waits w
      WHERE q.type = 'PendingDelete'::"JobQueueType" AND q."entityType" = d."entityType"
        AND q."entityId" = d."entityId" AND NOT d."askedElse" AND NOT d."inCase" AND NOT w."all"
      RETURNING q."entityType", q."entityId", q.data
    ),
    -- What the drain's hide took goes back with its ask (refreshLiftedKeptHides after the commit).
    ${toPrismaSql(liftKeptHides('released'))}
    ${toPrismaSql(selectLifted)}
  `;
}

/** The actor `remove-deleted-user-images` deletes as, which its queued deletes name. */
export const ACCOUNT_DELETION_DRAIN = 'remove-deleted-user-images';

/**
 * The rating the grace block recorded, while the row is still as the block left it (Blocked, same
 * rating lock, no CSAM block, now or recorded) and the level is a whole level. `restore`: one that
 * was locked or was itself Blocked, which a restore puts back. `floor`: any other, which the row is
 * re-rated from its current tags and then raised to, so a tag added during the window counts and an
 * unlocked rating that never came from tags (an owner's raise) is not lowered. NULL otherwise.
 */
const recordedLevelSql = (kind: 'restore' | 'floor', alias?: 'i') => {
  const col = (name: string) => Prisma.raw(`${alias ? `"${alias}"` : '"Image"'}."${name}"`);
  const meta = col('metadata');
  return Prisma.sql`CASE
    WHEN ${col('nsfwLevel')} = ${NsfwLevel.Blocked}
      AND to_jsonb(${col('nsfwLevelLocked')}) = ${meta}->${PRIOR_NSFW_LOCKED_KEY}::text
      AND (${csamBlockedSql(alias)}) IS NOT TRUE
      AND ${meta}->>${PRIOR_BLOCKED_FOR_KEY}::text IS DISTINCT FROM ${BlockedReason.CSAM}
      AND jsonb_typeof(${meta}->${PRIOR_NSFW_LEVEL_KEY}::text) = 'number'
      AND ${meta}->>${PRIOR_NSFW_LEVEL_KEY}::text ~ '^[1-9][0-9]{0,1}$'
      AND (${meta}->${PRIOR_NSFW_LOCKED_KEY}::text = 'true'::jsonb
        OR ${meta}->>${PRIOR_NSFW_LEVEL_KEY}::text = ${String(NsfwLevel.Blocked)}) = ${
    kind === 'restore'
  }
    THEN (${meta}->>${PRIOR_NSFW_LEVEL_KEY}::text)::int
  END`;
};

/**
 * Raises a re-rated row to the level the grace block recorded when the re-rate left it lower, with
 * the 'minor' review `update_nsfw_levels_new` gives a rated row whose scan saw a minor. Only an
 * unlocked, Scanned, unblocked row, as that recompute rates.
 */
async function raiseToRecordedFloor(rows: { id: number; floorLevel: number | null }[]) {
  const floors = rows.filter((x): x is { id: number; floorLevel: number } => x.floorLevel != null);
  if (!floors.length) return;
  const raised = await dbWrite.$queryRaw<{ id: number }[]>`
    UPDATE "Image" i
    SET "nsfwLevel" = f.level,
      "needsReview" = CASE
        WHEN i."needsReview" IN ('csam', 'appeal') THEN i."needsReview"
        WHEN (i."scanJobs"->'hasMinor')::boolean AND f.level > 1 AND f.level < ${NsfwLevel.Blocked}
        THEN 'minor'
        ELSE i."needsReview"
      END
    FROM unnest(${floors.map((x) => x.id)}::int[], ${floors.map(
    (x) => x.floorLevel
  )}::int[]) AS f(id, level)
    WHERE i.id = f.id
      AND i."nsfwLevel" < f.level
      AND NOT i."nsfwLevelLocked"
      AND i.ingestion = 'Scanned'::"ImageIngestionStatus"
      AND i."blockedFor" IS NULL
    RETURNING i.id
  `;
  if (raised.length) await refreshImageLevelCaches(raised.map((x) => x.id));
}

/** An account restore is no moderator's ruling on the media, so it lifts no withheld image. */
const WITHHELD_FROM_RESTORE = Prisma.raw(moderatorWithheldSql('i', { csamReview: false }));

/**
 * One restore pass: claims up to RESTORE_BATCH_SIZE of the account's grace-blocked rows, puts back
 * what the grace block recorded, and strips the breadcrumbs. `recordedLevel` is set on a row whose
 * recorded rating was put back; the caller re-rates the others, then raises each to its `floorLevel`.
 */
export function restoreAccountDeletionImageBatch(userId: number) {
  return dbWrite.$queryRaw<
    {
      id: number;
      postId: number | null;
      ingestion: string;
      blockedFor: string | null;
      needsReview: string | null;
      currentReview: string | null;
      recordedReview: string | null;
      recordedLevel: number | null;
      floorLevel: number | null;
      nsfwLevelLocked: boolean;
    }[]
  >`
    UPDATE "Image"
    SET ingestion = CASE
          WHEN "blockedFor" = ${
            BlockedReason.CSAM
          } OR "metadata"->>${PRIOR_BLOCKED_FOR_KEY}::text = ${BlockedReason.CSAM}
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
        -- Read from the updated row itself, not from the claim's columns.
        "nsfwLevel" = COALESCE(${recordedLevelSql('restore')}, "nsfwLevel"),
        "metadata" = "metadata"${minusPriorKeysSql}
    FROM (
      SELECT i.id, i."needsReview" AS "currentReview",
        -- A recorded appeal decided during the window has no queue left to clear it, and a row
        -- that keeps a CSAM block never takes the appeal review.
        CASE
          WHEN i."metadata"->>${PRIOR_NEEDS_REVIEW_KEY}::text = 'appeal' AND (
            NOT ${pendingImageAppealSql(Prisma.sql`i.id`)}
            OR (${csamBlockedSql('i')}) IS TRUE
            OR i."metadata"->>${PRIOR_BLOCKED_FOR_KEY}::text = ${BlockedReason.CSAM}
          ) THEN NULL
          ELSE i."metadata"->>${PRIOR_NEEDS_REVIEW_KEY}::text
        END AS "recordedReview",
        ${recordedLevelSql('restore', 'i')} AS "recordedLevel",
      ${recordedLevelSql('floor', 'i')} AS "floorLevel"
      FROM "Image" i
      WHERE i."userId" = ${userId}
        AND i.ingestion = 'Blocked'::"ImageIngestionStatus"
        AND i."metadata"->>${PRIOR_INGESTION_KEY}::text IS NOT NULL
        AND i."metadata"->>${PRIOR_INGESTION_KEY}::text IN (SELECT unnest(enum_range(NULL::"ImageIngestionStatus"))::text)
        AND (SELECT COALESCE(u."deletedAt", u."bannedAt") IS NULL FROM "User" u WHERE u.id = ${userId})
        AND NOT ${WITHHELD_FROM_RESTORE}
      LIMIT ${RESTORE_BATCH_SIZE}
      -- FOR UPDATE re-reads the newest row version, so a moderator rating committed mid-restore is
      -- not routed to the caller's re-rate, which would unlock it.
      FOR UPDATE OF i
    ) c
    WHERE "Image".id = c.id
    RETURNING "Image".id, "postId", ingestion, "blockedFor", "needsReview", "nsfwLevelLocked", c."currentReview", c."recordedReview", c."recordedLevel", c."floorLevel"
  `;
}

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
    const restored = await restoreAccountDeletionImageBatch(userId);

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

    // A row whose recorded rating was put back above; re-rating it would drop a moderator's lock.
    const rerate = visible.filter((x) => x.recordedLevel == null);
    const rated = visible.filter((x) => x.recordedLevel != null).map((x) => x.id);
    // One the restore left unlocked and found locked by the reset was rated by a moderator in
    // between: the reset passes it by.
    const rerateUnlocked = rerate.filter((x) => !x.nsfwLevelLocked).map((x) => x.id);
    const rerateLocked = rerate.filter((x) => x.nsfwLevelLocked).map((x) => x.id);
    if (ids.length)
      await limitConcurrency(
        [
          // Blocking force-set `nsfwLevel` to Blocked and left the rating lock on, which the
          // recompute skips; resetBlockedNsfwLevel is the shared undo for that.
          async () => {
            if (rerateUnlocked.length)
              await resetBlockedNsfwLevel(rerateUnlocked, { unlockedOnly: true });
            if (rerateLocked.length) await resetBlockedNsfwLevel(rerateLocked);
            await raiseToRecordedFloor(rerate);
          },
          () => refreshImageLevelCaches(rated),
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

  const [held] = await dbWrite.$queryRaw<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM "Image" i
    WHERE i."userId" = ${userId}
      AND i.ingestion = 'Blocked'::"ImageIngestionStatus"
      AND i."metadata"->>${PRIOR_INGESTION_KEY}::text IS NOT NULL
      AND ${WITHHELD_FROM_RESTORE}
  `;
  const withheld = held?.count ?? 0;
  if (withheld > 0)
    logToAxiom({
      type: 'info',
      name: 'account-deletion-image-restore',
      message: 'left withheld images blocked',
      userId,
      payload: { withheld },
    });

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

  return { unblocked, stillBlocked, skipped, withheld, drained };
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
