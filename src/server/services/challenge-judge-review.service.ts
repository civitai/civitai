import { dbRead, dbWrite } from '~/server/db/client';
import { bustContestCollectionItemsCache } from '~/server/services/contest-collection-items.cache';
import { judgeReviewCommentSql } from '~/server/games/daily-challenge/challenge-helpers';
import { clearLadder } from '~/server/games/daily-challenge/challenge-pairwise-store';
import { writeJudgeComment } from '~/server/services/commentv3/comment-write.service';
import { bulkDeleteComments } from '~/server/services/commentv3/moderation.service';
import { toggleReaction } from '~/server/services/reaction.service';
import type { ReviewReactions } from '~/shared/utils/prisma/enums';

/**
 * The challenge judge's review of an entry, and its undo. `rejudgeEntries` must undo every write
 * `writeJudgeReview` makes, so a new write belongs in both.
 */

/** Scores an entry and posts the judge's comment and reaction. A failed reaction does not fail it. */
export async function writeJudgeReview({
  collectionId,
  judgedTagId,
  judgeUserId,
  imageId,
  note,
  comment,
  reaction,
}: {
  collectionId: number;
  judgedTagId: number;
  judgeUserId: number;
  imageId: number;
  note: string;
  comment: string;
  reaction: ReviewReactions;
}) {
  await dbWrite.$executeRaw`
    UPDATE "CollectionItem"
    SET "tagId" = ${judgedTagId}, note = ${note}
    WHERE "collectionId" = ${collectionId} AND "imageId" = ${imageId};
  `;
  await bustContestCollectionItemsCache([imageId]);
  await writeJudgeComment({ userId: judgeUserId, imageId, content: comment });
  try {
    return await toggleReaction({
      entityType: 'image',
      entityId: imageId,
      reaction,
      userId: judgeUserId,
      eventPoints: false,
    });
  } catch {
    return 'reaction-failed' as const;
  }
}

/**
 * Undoes `writeJudgeReview` for every judged entry, and the challenge's ladder, then owes each entry
 * a new review. Run under the review job's lock.
 */
export async function rejudgeEntries({
  challengeId,
  collectionId,
  judgeUserId,
  judgedTagId,
}: {
  challengeId: number;
  collectionId: number;
  judgeUserId: number;
  judgedTagId: number;
}) {
  const judgeComment = judgeReviewCommentSql(judgeUserId);
  const imageIds = (
    await dbWrite.$queryRaw<{ imageId: number }[]>`
      SELECT ci."imageId" FROM "CollectionItem" ci
      WHERE ci."collectionId" = ${collectionId} AND ci.status = 'ACCEPTED'
        AND (
          (ci."tagId" = ${judgedTagId} AND ci.note IS NOT NULL)
          OR EXISTS (SELECT 1 FROM "CommentV3" cm WHERE cm."entityId" = ci."imageId" AND ${judgeComment})
        )
    `
  ).map((r) => r.imageId);
  if (!imageIds.length) return { entries: 0, comments: 0 };

  // Comments go first: the review skips an entry the judge has commented on, so an entry owed a
  // review before its comment is gone would be dropped from the list as already judged.
  const commentIds = (
    await dbWrite.$queryRaw<{ id: number }[]>`
      SELECT cm.id FROM "CommentV3" cm
      WHERE cm."entityId" = ANY(${imageIds}::int[]) AND ${judgeComment}
    `
  ).map((r) => r.id);
  await bulkDeleteComments({ ids: commentIds });

  const owed = JSON.stringify(Object.fromEntries(imageIds.map((imageId) => [imageId, 0])));
  await dbWrite.$transaction([
    // The review toggles the judge's reaction: a matching one left behind would be removed.
    dbWrite.imageReaction.deleteMany({ where: { imageId: { in: imageIds }, userId: judgeUserId } }),
    dbWrite.$executeRaw`
      UPDATE "CollectionItem" SET "tagId" = NULL, note = NULL
      WHERE "collectionId" = ${collectionId}
        AND "imageId" = ANY(${imageIds}::int[]) AND "tagId" = ${judgedTagId}
    `,
    ...clearLadder(challengeId),
    dbWrite.$executeRaw`
      UPDATE "Challenge"
      SET metadata = jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{pendingReview}',
        COALESCE(metadata->'pendingReview', '{}'::jsonb) || ${owed}::jsonb
      )
      WHERE id = ${challengeId}
    `,
  ]);
  await bustContestCollectionItemsCache(imageIds);
  return { entries: imageIds.length, comments: commentIds.length };
}

export async function getJudgeCommentForImage({
  imageId,
  judgeUserId,
}: {
  imageId: number;
  judgeUserId: number;
}) {
  const result = await dbRead.$queryRaw<[{ content: string }?]>`
    SELECT c.content
    FROM "CommentV3" c
    WHERE c."entityType" = 'image' AND c."entityId" = ${imageId} AND c."parentId" IS NULL
      AND c."userId" = ${judgeUserId} AND c."deletedAt" IS NULL
    ORDER BY c."createdAt" ASC
    LIMIT 1
  `;
  return result[0]?.content ?? null;
}
