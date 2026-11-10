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

/** `throwOnSendError` rejects when the send fails, rather than when there is nothing to send. */
export const createResourceReviewNotification = async (
  {
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
  },
  { throwOnSendError = false }: { throwOnSendError?: boolean } = {}
) => {
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

  await createNotification(
    {
      type: 'new-review',
      // One per reviewer and version, so a release that runs twice notifies once.
      key: `new-review:${modelVersionId}:${userId}`,
      category: NotificationCategory.Update,
      userId: modelVersion.model.userId,
      details: detailsObj,
    },
    { throwOnError: throwOnSendError }
  );
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

type ReleasedReview = {
  id: number;
  modelId: number;
  modelVersionId: number;
  recommended: boolean;
  userId: number;
  modelOwnerId: number;
};

// A post unpublished since its reviews were selected keeps them unmarked: its next go-live announces them.
const stillLive = Prisma.sql`AND EXISTS (
  SELECT 1 FROM "Post" p WHERE p.id = "ResourceReview"."postId" AND p."publishedAt" <= now()
)`;

/**
 * Notifies first and marks after, so a crash in between repeats a notification (a no-op on its key)
 * rather than losing one. A review whose notification throws stays unmarked for the next sweep.
 * Returns the reviews it marked.
 */
async function announceAndMark(
  candidates: ReleasedReview[],
  { requireLivePost = true }: { requireLivePost?: boolean } = {}
) {
  if (!candidates.length) return candidates;
  await bustRatingTotalsForRows(candidates).catch(() => undefined);
  const notified: ReleasedReview[] = [];
  for (const review of candidates) {
    const sent = await createResourceReviewNotification(review, { throwOnSendError: true }).then(
      () => true,
      () => false
    );
    if (sent) notified.push(review);
  }
  if (!notified.length) return notified;
  // Touched too, so the metric jobs recount them.
  const marked = await dbWrite.$queryRaw<{ id: number }[]>`
    UPDATE "ResourceReview"
    SET "releasedAt" = now(), "updatedAt" = now()
    WHERE id IN (${Prisma.join(notified.map((review) => review.id))})
      AND "releasedAt" IS NULL
      ${requireLivePost ? stillLive : Prisma.empty}
    RETURNING id
  `;
  const markedIds = new Set(marked.map((row) => row.id));
  return notified.filter((review) => markedIds.has(review.id));
}

const releasedReviewColumns = Prisma.sql`rr.id, rr."modelId", rr."modelVersionId", rr.recommended,
  rr."userId", m."userId" AS "modelOwnerId"`;

/**
 * Announces the unreleased reviews written from these posts once the post is live: the model owner
 * notified, the rating totals busted, the reviews marked released and touched for the metric jobs.
 * Reviews of a post still scheduled are left alone. The caller refreshes the owners' cached
 * has-received-reviews flag: the cache module imports this one.
 */
export async function releasePendingReviewsForPosts(postIds: number[]) {
  if (!postIds.length) return [];
  const candidates = await dbWrite.$queryRaw<ReleasedReview[]>`
    SELECT ${releasedReviewColumns}
    FROM "ResourceReview" rr
    JOIN "Post" p ON p.id = rr."postId"
    JOIN "Model" m ON m.id = rr."modelId"
    WHERE rr."postId" IN (${Prisma.join(postIds)})
      AND rr."releasedAt" IS NULL
      AND p."publishedAt" <= now()
  `;
  return announceAndMark(candidates);
}

/**
 * The scheduled-publishing job's sweep: announces every unreleased review of a live post, which
 * covers posts going live by the clock and any release that was missed or failed, whatever the
 * post's date. `ResourceReview_unreleased_postId_idx` keeps it to the linked, unreleased reviews.
 */
export async function releaseUnreleasedReviewsOfLivePosts({ limit = 1000 } = {}) {
  const candidates = await dbWrite.$queryRaw<ReleasedReview[]>`
    SELECT ${releasedReviewColumns}
    FROM "ResourceReview" rr
    JOIN "Post" p ON p.id = rr."postId"
    JOIN "Model" m ON m.id = rr."modelId"
    WHERE rr."postId" IS NOT NULL
      AND rr."releasedAt" IS NULL
      AND p."publishedAt" <= now()
    LIMIT ${limit}
  `;
  return announceAndMark(candidates);
}

/**
 * The unannounced reviews written from these posts. Read before the posts are deleted: the delete
 * nulls their `postId`, after which nothing links them to a post.
 */
export async function unreleasedReviewIdsOfPosts(
  postIds: number[],
  client: Pick<typeof dbWrite, '$queryRaw'> = dbWrite
) {
  if (!postIds.length) return [];
  const rows = await client.$queryRaw<{ id: number }[]>`
    SELECT id FROM "ResourceReview"
    WHERE "postId" IN (${Prisma.join(postIds)}) AND "releasedAt" IS NULL
  `;
  return rows.map((row) => row.id);
}

/**
 * Announces these reviews as standalone ones, whatever became of their post: for the reviews of a
 * deleted post, which the delete left public with no notification or recount.
 */
export async function announceReviews(reviewIds: number[]) {
  if (!reviewIds.length) return [];
  const candidates = await dbWrite.$queryRaw<ReleasedReview[]>`
    SELECT ${releasedReviewColumns}
    FROM "ResourceReview" rr
    JOIN "Model" m ON m.id = rr."modelId"
    WHERE rr.id IN (${Prisma.join(reviewIds)}) AND rr."releasedAt" IS NULL
  `;
  return announceAndMark(candidates, { requireLivePost: false });
}

/**
 * The reviews written from these posts count as pending again once the posts are taken down:
 * unmarked, so the next go-live announces them again, touched so the metric jobs recount them, the
 * rating totals busted. Nobody is notified.
 */
export async function refreshReviewsForUnpublishedPosts(postIds: number[]) {
  if (!postIds.length) return [];
  const refreshed = await dbWrite.$queryRaw<
    { modelId: number; modelVersionId: number; modelOwnerId: number }[]
  >`
    UPDATE "ResourceReview" rr
    SET "releasedAt" = NULL, "updatedAt" = now()
    FROM "Model" m
    WHERE m.id = rr."modelId" AND rr."postId" IN (${Prisma.join(postIds)})
    RETURNING rr."modelId", rr."modelVersionId", m."userId" AS "modelOwnerId"
  `;
  if (refreshed.length) await bustRatingTotalsForRows(refreshed).catch(() => undefined);
  return refreshed;
}

/**
 * The fire-and-forget form, for a caller whose post write has committed. A failure is logged: the
 * reviews are public or hidden regardless, read at request time, but the notification and the
 * metric recount wait for the scheduled-publishing sweep. `onReviews` gets
 * the touched reviews, for the owners' has-received-reviews refresh, which lives in the cache
 * module that imports this one.
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
  inBackground(
    `Failed to sync the resource reviews of ${change}ed posts`,
    { postIds },
    change === 'publish'
      ? releasePendingReviewsForPosts(postIds)
      : refreshReviewsForUnpublishedPosts(postIds),
    onReviews
  );
}

/** `announceReviews` in the same fire-and-forget form, for a delete that has committed. */
export function announceReviewsInBackground({
  reviewIds,
  onReviews,
}: {
  reviewIds: number[];
  onReviews: (reviews: { modelOwnerId: number }[]) => Promise<void>;
}) {
  if (!reviewIds.length) return;
  inBackground(
    'Failed to announce the reviews of a deleted post',
    { reviewIds },
    announceReviews(reviewIds),
    onReviews
  );
}

function inBackground(
  message: string,
  ids: Record<string, number[]>,
  sync: Promise<{ modelOwnerId: number }[]>,
  onReviews: (reviews: { modelOwnerId: number }[]) => Promise<void>
) {
  void sync
    .then((reviews) => onReviews(reviews))
    .catch((error) =>
      logToAxiom({
        name: 'resource-review',
        type: 'error',
        message,
        ...ids,
        error: (error as Error)?.message,
      }).catch(() => undefined)
    );
}
