import { Prisma } from '@prisma/client';
import { NotificationCategory } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { createNotification } from '~/server/services/notification.service';
import { bustRatingTotalsForRows } from '~/server/services/resourceReview.cache';

/**
 * A review written from an unpublished post stays hidden from everyone but its author until the
 * post is live. Pending is derived at read time, so unpublishing the post hides it again.
 */
export const visibleReviewWhere = (viewerId?: number): Prisma.ResourceReviewWhereInput => ({
  OR: [
    { postId: null },
    { post: { publishedAt: { lte: new Date() } } },
    ...(viewerId ? [{ userId: viewerId }] : []),
  ],
});

/** The SQL twin of `visibleReviewWhere`, without the author exception. A plain string, for the metric jobs. */
export const visibleReviewSql = (alias: string) =>
  `(${alias}."postId" IS NULL OR EXISTS (SELECT 1 FROM "Post" rvp WHERE rvp.id = ${alias}."postId" AND rvp."publishedAt" <= now()))`;

export const visibleReviewForViewerSql = (alias: string, viewerId?: number) =>
  viewerId
    ? Prisma.sql`(${Prisma.raw(visibleReviewSql(alias))} OR ${Prisma.raw(
        alias
      )}."userId" = ${viewerId})`
    : Prisma.raw(visibleReviewSql(alias));

export const createResourceReviewNotification = async ({
  id,
  modelId,
  modelVersionId,
  recommended,
  userId,
}: {
  id: number;
  modelId: number;
  modelVersionId: number;
  recommended: boolean;
  userId: number;
}) => {
  // don't send a notification for bad reviews
  if (!recommended) return;

  // TODO maybe add dedupe query

  const modelVersion = await dbRead.modelVersion.findFirst({
    where: { id: modelVersionId },
    select: {
      model: { select: { name: true, userId: true } },
      name: true,
    },
  });

  // don't send notification to self
  if (userId === modelVersion?.model.userId || modelVersion?.model.userId === -1) return;

  if (!modelVersion) {
    logToAxiom(
      {
        type: 'warning',
        name: 'Failed to create notification',
        details: { key: 'new-review' },
        message: 'Could not find modelVersion',
      },
      'notifications'
    ).catch();
    return;
  }

  const imageCount = await dbRead.imageResourceNew.count({
    where: { modelVersionId, image: { userId } },
  });

  // TODO if no content and no images, skip?
  // if (!imageCount && !content) return;

  const u = await dbRead.user.findFirst({
    where: { id: userId },
    select: { username: true },
  });

  const detailsObj = {
    version: 2,
    modelId: modelId,
    reviewId: id,
    modelName: modelVersion.model.name,
    modelVersionName: modelVersion.name,
    username: u?.username ?? '(unknown)',
    rating: recommended ? 5 : 1,
    recommended,
    imageCount,
  };

  await createNotification({
    type: 'new-review',
    key: `new-review:${modelVersionId}:${userId}`,
    category: NotificationCategory.Update,
    userId: modelVersion.model.userId,
    details: detailsObj,
  }).catch();
};

/** The post id, when the reviewer owns that post and it is not live yet; otherwise nothing. */
export async function pendingPostIdFor({ postId, userId }: { postId: number; userId: number }) {
  const post = await dbWrite.post.findUnique({
    where: { id: postId },
    select: { userId: true, publishedAt: true },
  });
  if (!post || post.userId !== userId) return undefined;
  if (post.publishedAt && post.publishedAt <= new Date()) return undefined;
  return postId;
}

/**
 * Makes the reviews written from these posts public once the post is live: touched so the metric
 * jobs recount them, the rating totals busted, the model owner notified. Reviews of a post still
 * scheduled are left for a later call. Safe to repeat: the notification key makes a second one a
 * no-op. The caller refreshes the owners' cached has-received-reviews flag: the cache module
 * imports this one.
 */
export async function releasePendingReviewsForPosts(postIds: number[]) {
  if (!postIds.length) return [];
  const released = await dbWrite.$queryRaw<
    {
      id: number;
      modelId: number;
      modelVersionId: number;
      recommended: boolean;
      userId: number;
      modelOwnerId: number;
    }[]
  >`
    UPDATE "ResourceReview" rr
    SET "updatedAt" = now()
    FROM "Post" p, "Model" m
    WHERE p.id = rr."postId"
      AND m.id = rr."modelId"
      AND rr."postId" IN (${Prisma.join(postIds)})
      AND p."publishedAt" <= now()
    RETURNING rr.id, rr."modelId", rr."modelVersionId", rr.recommended, rr."userId",
      m."userId" AS "modelOwnerId"
  `;
  if (!released.length) return released;
  await bustRatingTotalsForRows(released).catch(() => undefined);
  for (const review of released)
    await createResourceReviewNotification(review).catch(() => undefined);
  return released;
}

/**
 * The reviews written from these posts count as pending again once the posts are taken down:
 * touched so the metric jobs recount them, the rating totals busted. Nobody is notified.
 */
export async function refreshReviewsForUnpublishedPosts(postIds: number[]) {
  if (!postIds.length) return [];
  const refreshed = await dbWrite.$queryRaw<
    { modelId: number; modelVersionId: number; modelOwnerId: number }[]
  >`
    UPDATE "ResourceReview" rr
    SET "updatedAt" = now()
    FROM "Model" m
    WHERE m.id = rr."modelId" AND rr."postId" IN (${Prisma.join(postIds)})
    RETURNING rr."modelId", rr."modelVersionId", m."userId" AS "modelOwnerId"
  `;
  if (refreshed.length) await bustRatingTotalsForRows(refreshed).catch(() => undefined);
  return refreshed;
}

/**
 * The fire-and-forget form, for a caller whose post write has committed: a failure is logged and
 * leaves only held reviews or stale counts. `onReviews` gets the touched reviews, for the owners'
 * has-received-reviews refresh, which lives in the cache module that imports this one.
 */
export function syncReviewsOfMovedPosts({
  change,
  postIds,
  onReviews,
}: {
  change: 'publish' | 'unpublish';
  postIds: number[];
  onReviews: (reviews: { modelOwnerId: number }[]) => Promise<void>;
}) {
  if (!postIds.length) return;
  const sync =
    change === 'publish'
      ? releasePendingReviewsForPosts(postIds)
      : refreshReviewsForUnpublishedPosts(postIds);
  void sync
    .then((reviews) => onReviews(reviews))
    .catch((error) =>
      logToAxiom({
        name: 'resource-review',
        type: 'error',
        message: `Failed to sync the resource reviews of ${change}ed posts`,
        postIds,
        error: (error as Error)?.message,
      }).catch(() => undefined)
    );
}
