import { uniq } from 'lodash-es';
import { EntityType, JobQueueType } from '~/shared/utils/prisma/enums';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  queueImageSearchIndexUpdate,
  resetBlockedNsfwLevel,
} from '~/server/services/image.service';
import { bustCachesForPosts } from '~/server/services/post.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { PRIOR_BLOCKED_FOR_KEY, PRIOR_INGESTION_KEY } from '~/server/utils/image-removal-mode';

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
 * Undoes the grace block, keyed off the `Image.metadata` breadcrumbs the block wrote rather than
 * off `blockedFor`: a moderator block is also `blockedFor = 'moderated'`, so anything scoped that
 * way would unblock content a moderator hid. Restoring the recorded values rather than forcing
 * `Scanned`/`NULL` keeps an image that was mid-scan (or blocked for `AiNotVerified`) in the state
 * it was actually in.
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
      { id: number; postId: number | null; ingestion: string }[]
    >`
      UPDATE "Image"
      SET ingestion = ("metadata"->>${PRIOR_INGESTION_KEY}::text)::"ImageIngestionStatus",
          "blockedFor" = "metadata"->>${PRIOR_BLOCKED_FOR_KEY}::text,
          "metadata" = "metadata" - ${PRIOR_INGESTION_KEY}::text - ${PRIOR_BLOCKED_FOR_KEY}::text
      WHERE id IN (
        SELECT i.id
        FROM "Image" i
        WHERE i."userId" = ${userId}
          AND i.ingestion = 'Blocked'::"ImageIngestionStatus"
          AND i."metadata"->>${PRIOR_INGESTION_KEY}::text IS NOT NULL
          AND i."metadata"->>${PRIOR_INGESTION_KEY}::text IN (SELECT unnest(enum_range(NULL::"ImageIngestionStatus"))::text)
        LIMIT ${RESTORE_BATCH_SIZE}
      )
      RETURNING id, "postId", ingestion
    `;

    if (!restored.length) {
      drained = true;
      break;
    }

    const visible = restored.filter((x) => x.ingestion !== 'Blocked');
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
    await logToAxiom({
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
    }).catch(() => undefined);

  return { unblocked, stillBlocked, skipped };
}
