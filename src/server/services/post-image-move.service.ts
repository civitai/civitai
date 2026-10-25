import { Prisma } from '@prisma/client';
import { uniq } from 'lodash-es';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { preventReplicationLag } from '~/server/db/db-lag-helpers';
import { logToAxiom, safeError } from '~/server/logging/client';
import { postMetrics } from '~/server/metrics';
import { userPostCountCache } from '~/server/redis/caches';
import type { MoveImagesToPostInput } from '~/server/schema/post.schema';
import { createImageResources, queueImageSearchIndexUpdate } from '~/server/services/image.service';
import { enqueueJobs } from '~/server/services/job-queue.service';
import { assertAccountNotUnderLegalHold } from '~/server/services/legal-hold.service';
import { bustCachesForPosts, updatePostNsfwLevel } from '~/server/services/post.service';
import { bustCacheTag } from '~/server/utils/cache-helpers';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import type { Availability } from '~/shared/utils/prisma/enums';
import { EntityType, ImageIngestionStatus, JobQueueType } from '~/shared/utils/prisma/enums';
import type { ImageMoveRefusal, MovePostRow } from '~/server/services/post-image-move.rules';
import { getImageMoveRefusal, IMAGES_NOT_MOVABLE } from '~/server/services/post-image-move.rules';

function throwRefusal(refusal: ImageMoveRefusal): never {
  if (refusal.kind === 'not-found') throw throwNotFoundError(refusal.message);
  if (refusal.kind === 'unauthorized') throw throwAuthorizationError(refusal.message);
  throw throwBadRequestError(refusal.message);
}

export async function moveImagesToPost({
  imageIds: inputImageIds,
  fromPostId,
  toPostId,
  userId,
}: MoveImagesToPostInput & { userId: number }) {
  const imageIds = uniq(inputImageIds);

  await assertAccountNotUnderLegalHold(userId).catch(() => {
    throw throwBadRequestError(IMAGES_NOT_MOVABLE);
  });

  const { targetPostId, targetModelVersionId } = await dbWrite.$transaction(async (tx) => {
    const postIds = toPostId ? [fromPostId, toPostId] : [fromPostId];
    // Locked so concurrent moves into the same post cannot both pass the image cap.
    const posts = await tx.$queryRaw<
      (MovePostRow & {
        modelVersionId: number | null;
        availability: Availability;
        unlisted: boolean;
      })[]
    >`
      SELECT p.id, p."userId", p."publishedAt", p."tosViolation", p."modelVersionId",
             p.availability, p.unlisted,
             COALESCE(c.mode = 'Contest'::"CollectionMode", false) AS "isContest",
             EXISTS (SELECT 1 FROM "StorylineChapter" sc WHERE sc."postId" = p.id) AS "isChapter"
      FROM "Post" p
      LEFT JOIN "Collection" c ON c.id = p."collectionId"
      WHERE p.id IN (${Prisma.join(postIds)})
      ORDER BY p.id
      FOR UPDATE OF p
    `;
    const source = posts.find((p) => p.id === fromPostId);
    const target = toPostId ? posts.find((p) => p.id === toPostId) : null;

    const images = await tx.image.findMany({
      where: { id: { in: imageIds } },
      select: {
        id: true,
        userId: true,
        postId: true,
        tosViolation: true,
        ingestion: true,
        needsReview: true,
      },
    });
    const sourceImageCount = await tx.image.count({ where: { postId: fromPostId } });
    const targetImageCount = target ? await tx.image.count({ where: { postId: target.id } }) : 0;

    const refusal = getImageMoveRefusal({
      userId,
      imageIds,
      source,
      target,
      images,
      sourceImageCount,
      targetImageCount,
    });
    if (refusal) throwRefusal(refusal);
    // Narrowed by the refusal check above.
    const sourcePost = source as NonNullable<typeof source> & { publishedAt: Date };

    let destination = target;
    if (!destination) {
      const created = await tx.post.create({
        data: {
          userId,
          availability: sourcePost.availability,
          unlisted: sourcePost.unlisted,
        },
        select: { id: true },
      });
      // Published by UPDATE rather than on insert so the publish triggers
      // (`publish_post_metrics`, `post_nsfw_level_change`) fire as for any other post.
      await tx.post.update({
        where: { id: created.id },
        data: { publishedAt: sourcePost.publishedAt },
      });
      destination = {
        ...sourcePost,
        id: created.id,
        isContest: false,
        isChapter: false,
        tosViolation: false,
      };
    }

    const {
      _max: { index: maxIndex },
    } = await tx.image.aggregate({ where: { postId: destination.id }, _max: { index: true } });
    const firstIndex = (maxIndex ?? -1) + 1;
    for (const [i, id] of imageIds.entries()) {
      // Image rows are not locked, so the write re-checks what the refusal read.
      const { count } = await tx.image.updateMany({
        where: {
          id,
          userId,
          postId: fromPostId,
          tosViolation: false,
          needsReview: null,
          ingestion: ImageIngestionStatus.Scanned,
        },
        data: { postId: destination.id, index: firstIndex + i },
      });
      if (count !== 1) throw throwBadRequestError('An image changed while moving; try again');
    }

    // A postId change fires no nsfw trigger, and `update-nsfw-levels` is the only writer of
    // Post.nsfwLevel (and walks on to the model version and model).
    await enqueueJobs(
      [
        { entityId: fromPostId, entityType: EntityType.Post, type: JobQueueType.UpdateNsfwLevel },
        {
          entityId: destination.id,
          entityType: EntityType.Post,
          type: JobQueueType.UpdateNsfwLevel,
        },
        { entityId: fromPostId, entityType: EntityType.Post, type: JobQueueType.CleanIfEmpty },
      ],
      tx
    );

    return { targetPostId: destination.id, targetModelVersionId: target?.modelVersionId ?? null };
  });

  const postIds = [fromPostId, targetPostId];
  const results = await Promise.allSettled([
    updatePostNsfwLevel(postIds),
    bustCachesForPosts(postIds),
    ...postIds.map((id) => preventReplicationLag('postImages', id)),
    queueImageSearchIndexUpdate({ ids: imageIds, action: SearchIndexUpdateQueueAction.Update }),
    postMetrics.queueUpdate(postIds),
    bustCacheTag(`images-user:${userId}`),
    userPostCountCache.refresh(userId),
    ...(targetModelVersionId ? imageIds.map((imageId) => createImageResources({ imageId })) : []),
  ]);
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failures.length)
    await logToAxiom({
      type: 'error',
      name: 'move-images-to-post-followup-failed',
      message: 'Images moved, but a follow-up step failed',
      imageIds,
      fromPostId,
      toPostId: targetPostId,
      errors: failures.map((f) => safeError(f.reason)),
    }).catch(() => undefined);

  return { postId: targetPostId };
}

export type ImageMoveTarget = {
  id: number;
  title: string | null;
  publishedAt: Date;
  imageCount: number;
  coverUrl: string | null;
};

/** The caller's posts a move out of `fromPostId` could land in, newest first. */
export async function getImageMoveTargets({
  fromPostId,
  userId,
}: {
  fromPostId: number;
  userId: number;
}): Promise<ImageMoveTarget[]> {
  return dbRead.$queryRaw<ImageMoveTarget[]>`
    SELECT p.id, p.title, p."publishedAt", img."imageCount"::int AS "imageCount", img."coverUrl"
    FROM "Post" src
    JOIN "Post" p ON p."userId" = src."userId"
      AND p."publishedAt" <= LEAST(src."publishedAt", now())
      AND p.id != src.id
      AND NOT p."tosViolation"
    LEFT JOIN "Collection" c ON c.id = p."collectionId"
    CROSS JOIN LATERAL (
      SELECT count(*) AS "imageCount",
             (array_agg(i.url ORDER BY i.index NULLS LAST, i.id))[1] AS "coverUrl"
      FROM "Image" i
      WHERE i."postId" = p.id
    ) img
    WHERE src.id = ${fromPostId}
      AND src."userId" = ${userId}
      AND c.mode IS DISTINCT FROM 'Contest'::"CollectionMode"
    ORDER BY p."publishedAt" DESC
    LIMIT 50
  `;
}
