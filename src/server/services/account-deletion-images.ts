import { chunk, uniq } from 'lodash-es';
import { EntityType, JobQueueType } from '~/shared/utils/prisma/enums';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import {
  queueImageSearchIndexUpdate,
  resetBlockedNsfwLevel,
} from '~/server/services/image.service';
import { bustCachesForPosts } from '~/server/services/post.service';
import { PRIOR_BLOCKED_FOR_KEY, PRIOR_INGESTION_KEY } from '~/server/utils/image-removal-mode';

const RESTORE_BATCH_SIZE = 500;

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
 */
export async function unblockAccountDeletionImages(userId: number) {
  const restored = await dbWrite.$queryRaw<
    { id: number; postId: number | null; ingestion: string }[]
  >`
    UPDATE "Image"
    SET ingestion = ("metadata"->>${PRIOR_INGESTION_KEY}::text)::"ImageIngestionStatus",
        "blockedFor" = "metadata"->>${PRIOR_BLOCKED_FOR_KEY}::text,
        "metadata" = "metadata" - ${PRIOR_INGESTION_KEY}::text - ${PRIOR_BLOCKED_FOR_KEY}::text
    WHERE "userId" = ${userId}
      AND ingestion = 'Blocked'::"ImageIngestionStatus"
      AND "metadata"->>${PRIOR_INGESTION_KEY}::text IS NOT NULL
    RETURNING id, "postId", ingestion
  `;

  const visible = restored.filter((x) => x.ingestion !== 'Blocked');
  const ids = visible.map((x) => x.id);
  const postIds = uniq(visible.map((x) => x.postId).filter((id): id is number => id != null));

  for (const batch of chunk(ids, RESTORE_BATCH_SIZE)) {
    // Blocking force-set `nsfwLevel` to Blocked and left the rating lock on, which the recompute
    // skips; resetBlockedNsfwLevel is the shared undo for that.
    await resetBlockedNsfwLevel(batch);
    await queueImageSearchIndexUpdate({ ids: batch, action: SearchIndexUpdateQueueAction.Update });
  }
  for (const batch of chunk(postIds, RESTORE_BATCH_SIZE)) await bustCachesForPosts(batch);

  return { unblocked: ids.length, stillBlocked: restored.length - ids.length };
}
