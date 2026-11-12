import { keepHeldReviewsCte } from '~/server/services/held-review.service';
import { holdMarkerViewExists } from '~/server/services/legal-hold.service';
import { Prisma } from '@prisma/client';
import type { ResourceReview } from '@prisma/client';
import { countedTopLevelCommentSql } from '~/server/services/comment-count.sql';
import { NsfwLevel } from '~/server/common/enums';
import { imageReviewedSql } from '~/server/common/image-visibility';
import { CacheTTL } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';

import { getKyselyWithoutLag } from '~/server/db/db-lag-helpers';
import {
  readUserResourceReviewsViaKysely,
  readUserResourceReviewsViaPrisma,
} from '~/server/services/hot-reads-5.reads';
import { loadKyselyDb } from '~/server/db/kyselyDb.lazy';
import { readUserReviewsViaKysely } from '~/server/services/hot-reads-6.reads';
import { onModelReviewsChanged } from '~/server/events/points/hooks';
import { logToAxiom } from '~/server/logging/client';
import type { GetByIdInput } from '~/server/schema/base.schema';
import type { GetResourceReviewsInput } from '~/server/schema/resourceReview.schema';
import {
  resourceReviewSelect,
  resourceReviewSimpleSelect,
} from '~/server/selectors/resourceReview.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import {
  getBlockCheckOwnerIds,
  throwIfBlockedByOwners,
} from '~/server/services/block-check.service';
import {
  BlockedByUsers,
  BlockedUsers,
  HiddenUsers,
} from '~/server/services/user-preferences.service';
import { boundExcludedUserIds } from '~/server/utils/excluded-user-ids';
import {
  amIBlockedByUser,
  getBasicDataForUsers,
  getCosmeticsForUsers,
  getProfilePicturesForUsers,
} from '~/server/services/user.service';
import { queryCache } from '~/server/utils/cache-helpers';
import {
  bustRatingTotalsCache,
  bustRatingTotalsForRows,
} from '~/server/services/resourceReview.cache';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { getPagingData } from '~/server/utils/pagination-helpers';
import type { UpsertResourceReviewInput } from '../schema/resourceReview.schema';
import { REVIEW_IMAGE_COUNT_CAP } from '~/server/schema/resourceReview.schema';
import type {
  CreateResourceReviewInput,
  GetRatingTotalsInput,
  GetResourceReviewPagedInput,
  GetResourceReviewsInfiniteInput,
  GetUserResourceReviewInput,
  UpdateResourceReviewInput,
} from './../schema/resourceReview.schema';
import { queueScamScan } from '~/server/services/text-scan/scam-scan-queue';
import {
  createResourceReviewNotification,
  pendingPostIdFor,
  visibleReviewForViewerSql,
  visibleReviewSql,
  visibleReviewWhere,
} from '~/server/services/resourceReview.visibility';

export type ResourceReviewDetailModel = AsyncReturnType<typeof getResourceReview>;
export const getResourceReview = async ({
  id,
  userId,
  isModerator,
}: GetByIdInput & { userId?: number; isModerator?: boolean }) => {
  const result = await dbRead.resourceReview.findFirst({
    // A moderator opens a pending review from a report or a notification.
    where: { id, ...(isModerator ? {} : visibleReviewWhere(userId)) },
    select: {
      ...resourceReviewSelect,
      model: { select: { name: true, id: true, userId: true, status: true } },
    },
  });
  if (!result || result.model.status !== 'Published') throw throwNotFoundError();

  if (userId && !isModerator) {
    const blocked = await amIBlockedByUser({ userId, targetUserId: result.user.id });
    if (blocked) throw throwNotFoundError();
  }

  const commentCounts = await getReviewCommentCounts([id]);
  return { ...result, thread: { commentCount: commentCounts.get(id) ?? 0 } };
};

export const getUserResourceReview = async ({
  modelId,
  modelVersionId,
  userId,
  tx,
}: GetUserResourceReviewInput & { userId: number; tx?: Prisma.TransactionClient }) => {
  if (!userId) throw throwAuthorizationError();
  if (!tx)
    return readUserResourceReviewsViaKysely(await getKyselyWithoutLag('resourceReview', userId), {
      modelId,
      modelVersionId,
      userId,
    });
  // Inside a transaction the read stays on that transaction, through Prisma.
  const results = await readUserResourceReviewsViaPrisma(tx, {
    modelId,
    modelVersionId,
    userId,
  });
  if (!results) return null;

  return results;
};

export const getResourceReviewsByUserId = async ({
  userId,
  recommended,
  modelIds,
}: {
  userId: number;
  recommended?: boolean;
  // When provided, bound the scan to these models (membership queries). Omitted =
  // unfiltered = existing behavior for the current whole-history callers.
  modelIds?: number[];
}) => {
  return readUserReviewsViaKysely((await loadKyselyDb()).kyselyRead, {
    userId,
    recommended,
    modelIds,
  });
};

export const getResourceReviews = async ({ resourceIds }: GetResourceReviewsInput) => {
  return await dbRead.resourceReview.findMany({
    where: { modelVersionId: { in: resourceIds }, ...visibleReviewWhere() },
    select: {
      id: true,
      modelVersionId: true,
      rating: true,
      recommended: true,
      details: true,
    },
  });
};

export const getResourceReviewsInfinite = async ({
  limit,
  cursor,
  modelId,
  modelVersionId,
  username,
  include,
  hasDetails,
  viewerId,
}: GetResourceReviewsInfiniteInput & { viewerId?: number }) => {
  const AND: Prisma.Enumerable<Prisma.ResourceReviewWhereInput> = [visibleReviewWhere(viewerId)];
  const orderBy: Prisma.Enumerable<Prisma.ResourceReviewOrderByWithRelationInput> = [];

  if (username) {
    const userFindArgs = { where: { username }, select: { id: true } };
    const targetUser =
      (await dbRead.user.findUnique(userFindArgs)) ?? (await dbWrite.user.findUnique(userFindArgs));

    if (!targetUser) throw throwNotFoundError('User not found');

    AND.push({
      userId: {
        not: targetUser.id,
      },
      model: {
        userId: targetUser.id,
      },
    });
  }
  if (modelId) AND.push({ modelId });
  if (modelVersionId) AND.push({ modelVersionId });
  if (hasDetails) AND.push({ details: { not: null } });

  if (!username) {
    AND.push({ details: { not: null } });
  }

  orderBy.push({ createdAt: 'desc' });
  const items = await dbRead.resourceReview.findMany({
    take: limit + 1,
    cursor: cursor ? { id: cursor } : undefined,
    where: { AND },
    orderBy,
    select: {
      id: true,
      modelId: true,
      modelVersionId: true,
      details: true,
      createdAt: true,
      rating: true,
      recommended: true,
      user: { select: userWithCosmeticsSelect },
      // helper: { select: { imageCount: true } },
      model: include?.includes('model')
        ? {
            select: { id: true, name: true },
          }
        : undefined,
      modelVersion: include?.includes('model')
        ? {
            select: {
              id: true,
              name: true,
            },
          }
        : undefined,
    },
  });

  let nextCursor: number | undefined;
  if (items.length > limit) {
    const nextItem = items.pop();
    nextCursor = nextItem?.id;
  }

  const commentCounts = await getReviewCommentCounts(items.map((item) => item.id));
  return {
    nextCursor,
    items: items.map((item) => ({
      ...item,
      thread: { commentCount: commentCounts.get(item.id) ?? 0 },
    })),
  };
};

/** Not `CommentTopic.commentCount`: that counts replies and tombstones, so the shown number would jump. */
async function getReviewCommentCounts(reviewIds: number[]) {
  if (!reviewIds.length) return new Map<number, number>();
  const rows = await dbRead.$queryRaw<{ reviewId: number; count: number }[]>`
    SELECT "entityId" AS "reviewId", COUNT(*)::int AS count
    FROM "CommentV3" v
    WHERE ${countedTopLevelCommentSql(Prisma.raw('v'), 'review')}
      AND "entityId" IN (${Prisma.join(reviewIds)})
    GROUP BY "entityId"
  `;
  return new Map(rows.map((row) => [row.reviewId, row.count]));
}

export type RatingTotalsModel = {
  '1': number;
  '2': number;
  '3': number;
  '4': number;
  '5': number;
  up: number;
  down: number;
};
type GetRatingTotalsRow = { rating: number; recommended: boolean | null; count: number };
export const getRatingTotals = async ({ modelVersionId, modelId }: GetRatingTotalsInput) => {
  const AND: Prisma.Sql[] = [];
  if (modelVersionId) AND.push(Prisma.sql`rr."modelVersionId" = ${modelVersionId}`);
  else AND.push(Prisma.sql`rr."modelId" = ${modelId}`);

  const query = Prisma.sql`
    SELECT
      rr.rating,
      rr.recommended,
      COUNT(rr.id)::int count
    FROM "ResourceReview" rr
    JOIN "Model" m ON rr."modelId" = m.id AND m."userId" != rr."userId"
    WHERE ${Prisma.join(AND, ' AND ')} AND NOT rr.exclude
      AND ${Prisma.raw(visibleReviewSql('rr'))}
      AND rr.recommended -- Only expose recommended reviews
    GROUP BY rr.rating, rr.recommended
  `;

  const cacheable = queryCache(dbRead, 'getRatingTotals', 'v1');
  const result = await cacheable<GetRatingTotalsRow[]>(query, {
    ttl: CacheTTL.hour,
    tag: modelVersionId ? [`rating:modelVersion:${modelVersionId}`] : [`rating:model:${modelId}`],
  });

  const transformed = result.reduce(
    (acc, { rating, recommended, count }) => {
      const key = rating.toString() as keyof RatingTotalsModel;
      if (acc[key] !== undefined) acc[key] = count;
      // Need to check explicitly because of null
      if (recommended === true) acc.up += count;
      else if (recommended === false) acc.down += count;

      return acc;
    },
    { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, up: 0, down: 0 }
  );

  return transformed;
};

// Read through the writer: on the replica a review created seconds ago resolves no model, the
// guard finds no owner to refuse against, and the write it guards then succeeds anyway.
const storedReviewModelId = async (id: number) =>
  (await dbWrite.resourceReview.findUnique({ where: { id }, select: { modelId: true } }))?.modelId;

/**
 * A review is content on someone else's model, so the model's owner is the block target. Resolved
 * through the shared owner map and refused in one call, the way the comment paths do it — a
 * throw-per-id loop would skip the self-and-duplicate handling that lives in `throwIfBlockedByOwners`.
 */
async function throwIfBlockedByModelOwners({
  userId,
  isModerator,
  modelIds,
}: {
  userId: number;
  isModerator?: boolean;
  modelIds: Array<number | null | undefined>;
}) {
  const ids = [...new Set(modelIds.filter((x): x is number => !!x))];
  const ownerIds = (
    await Promise.all(
      ids.map((entityId) => getBlockCheckOwnerIds({ entityType: 'model', entityId }))
    )
  ).flat();
  await throwIfBlockedByOwners({ userId, ownerIds, isModerator });
}

export const upsertResourceReview = async ({
  userId,
  isModerator,
  postId,
  ...data
}: UpsertResourceReviewInput & { userId: number; isModerator?: boolean }) => {
  await throwOnBlockedUserContent(data.details, { isModerator, surface: 'resourceReview' });
  // Edits too, not just creates — a review written before a block would otherwise stay editable
  // into anything afterwards. An edit writes `modelId` through from the request while being scoped
  // by review id, so the review's stored model is checked alongside the one the request names.
  const storedModelId = data.id ? await storedReviewModelId(data.id) : undefined;
  await throwIfBlockedByModelOwners({
    userId,
    isModerator,
    modelIds: [data.modelId, storedModelId],
  });

  if (!data.id) {
    const pendingPostId = postId ? await pendingPostIdFor({ postId, userId }) : undefined;
    const select = { ...resourceReviewSelect, postId: true };
    const ret = await dbWrite.resourceReview
      .create({
        data: { ...data, userId, postId: pendingPostId },
        select,
      })
      .catch(async (err) => {
        // Concurrent create race: the (modelVersionId, userId) unique constraint
        // trips (P2002). The review already exists — resolve idempotently by
        // returning the existing row instead of bubbling a 500.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          return dbWrite.resourceReview.findUniqueOrThrow({
            where: { modelVersionId_userId: { modelVersionId: data.modelVersionId, userId } },
            select,
          });
        }
        throw err;
      });
    // A review linked to a post is notified when the post goes live, by releasePendingReviewsForPosts.
    if (!ret.postId) await createResourceReviewNotification({ ...ret, userId }).catch();
    await bustRatingTotalsCache({
      modelId: data.modelId,
      modelVersionId: data.modelVersionId,
    }).catch();
    if (data.details) queueScamScan({ entityType: 'ResourceReview', entityId: ret.id });
    void onModelReviewsChanged([{ modelId: data.modelId, userId }]);
    return ret;
  } else {
    const ret = await dbWrite.resourceReview.update({
      where: { id: data.id },
      data,
      select: { id: true, modelId: true, modelVersionId: true, userId: true },
    });
    // An edit can move the review to another model, so the model it left is re-checked too.
    void onModelReviewsChanged([
      ret,
      ...(storedModelId ? [{ modelId: storedModelId, userId: ret.userId }] : []),
    ]);
    await bustRatingTotalsCache({
      modelId: ret.modelId,
      modelVersionId: ret.modelVersionId,
    }).catch();
    if (data.details) queueScamScan({ entityType: 'ResourceReview', entityId: ret.id });
    return ret;
  }
};

/**
 * Deletes the reviews `reviews` selects, copying a held author's into "HeldResourceReview" in the
 * same statement. Returns the deleted rows.
 */
async function deleteReviews(reviews: Prisma.Sql) {
  const markerView = await holdMarkerViewExists();
  return dbWrite.$queryRaw<ResourceReview[]>`
    WITH ${keepHeldReviewsCte(reviews, markerView)}
    DELETE FROM "ResourceReview" WHERE id IN (${reviews})
    RETURNING id, "modelId", "modelVersionId", rating, recommended, details, "userId", "createdAt",
      "updatedAt", exclude, nsfw, "tosViolation", metadata`;
}

export const deleteResourceReview = async ({ id }: GetByIdInput) => {
  // resourceReview.controller.ts and the client read the deleted row.
  const [ret] = await deleteReviews(Prisma.sql`SELECT ${id}::int`);
  if (!ret) throw throwNotFoundError(`No review with id ${id}`);
  void onModelReviewsChanged([ret]);
  await bustRatingTotalsCache({
    modelId: ret.modelId,
    modelVersionId: ret.modelVersionId,
  }).catch();
  return ret;
};

export async function setExcludeResourceReviews({
  ids,
  exclude,
}: {
  ids: number[];
  exclude: boolean;
}) {
  if (ids.length === 0) return { count: 0 };
  // Collect affected model/version ids BEFORE the update so we can bust the
  // rating-totals cache. setExclude flips the `NOT rr.exclude` filter, so the
  // totals shift even though rating/recommended don't change.
  const affected = await dbRead.resourceReview.findMany({
    where: { id: { in: ids } },
    select: { modelId: true, modelVersionId: true },
  });
  const result = await dbWrite.resourceReview.updateMany({
    where: { id: { in: ids } },
    data: { exclude },
  });
  await bustRatingTotalsForRows(affected).catch();
  return { count: result.count };
}

export async function deleteResourceReviews({ ids }: { ids: number[] }) {
  if (ids.length === 0) return { count: 0 };
  const deleted = await deleteReviews(Prisma.sql`SELECT unnest(${ids}::int[])`);
  void onModelReviewsChanged(deleted);
  await bustRatingTotalsForRows(deleted).catch();
  return { count: deleted.length };
}

export const createResourceReview = async ({
  isModerator,
  ...data
}: CreateResourceReviewInput & { userId: number; isModerator?: boolean }) => {
  await throwOnBlockedUserContent(data.details, { isModerator, surface: 'resourceReview' });

  await throwIfBlockedByModelOwners({
    userId: data.userId,
    isModerator,
    modelIds: [data.modelId],
  });
  const select = { ...resourceReviewSimpleSelect, postId: true };
  const ret = await dbWrite.resourceReview.create({ data, select }).catch(async (err) => {
    // Concurrent create race: the (modelVersionId, userId) unique constraint
    // trips (P2002). The review already exists — resolve idempotently by
    // returning the existing row instead of bubbling a 500.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return dbWrite.resourceReview.findUniqueOrThrow({
        where: {
          modelVersionId_userId: { modelVersionId: data.modelVersionId, userId: data.userId },
        },
        select,
      });
    }
    throw err;
  });
  // The race can return a review written from a post, which is notified when that post goes live.
  if (!ret.postId) await createResourceReviewNotification({ ...ret, userId: data.userId }).catch();
  void onModelReviewsChanged([{ modelId: data.modelId, userId: data.userId }]);
  await bustRatingTotalsCache({
    modelId: data.modelId,
    modelVersionId: data.modelVersionId,
  }).catch();
  if (data.details) queueScamScan({ entityType: 'ResourceReview', entityId: ret.id });
  return ret;
};

export const updateResourceReview = async ({
  id,
  userId,
  isModerator,
  ...data
}: UpdateResourceReviewInput & { userId: number; isModerator?: boolean }) => {
  await throwOnBlockedUserContent(data.details, { isModerator, surface: 'resourceReview' });

  // The request carries no modelId, so the review's stored model is the only target.
  await throwIfBlockedByModelOwners({
    userId,
    isModerator,
    modelIds: [await storedReviewModelId(id)],
  });
  const ret = await dbWrite.resourceReview.update({
    where: { id },
    data,
    select: {
      id: true,
      modelId: true,
      modelVersionId: true,
      rating: true,
      recommended: true,
      nsfw: true,
      userId: true,
    },
  });
  void onModelReviewsChanged([ret]);
  await bustRatingTotalsCache({
    modelId: ret.modelId,
    modelVersionId: ret.modelVersionId,
  }).catch();
  if (data.details) queueScamScan({ entityType: 'ResourceReview', entityId: ret.id });
  return ret;
};

type ResourceReviewRow = {
  id: number;
  modelVersionId: number;
  modelId?: number | null;
  rating: number;
  recommended: boolean;
  details: string | null;
  createdAt: Date;
  nsfw: boolean;
  exclude: boolean;
  metadata: any;
  userId: number;
  postId: number | null;
  commentCount: number;
};
// `details` is editor HTML, so an emptied review can be `<p></p>` rather than NULL. The plain
// NULL/empty term matches the partial index on `details`, so the regex runs only on written rows.
export const writtenReviewSql = Prisma.sql`(
  NOT rr.exclude AND NOT rr."tosViolation" AND NOT rr.nsfw
  AND rr.details IS NOT NULL AND rr.details <> ''
  AND btrim(regexp_replace(coalesce(rr.details, ''), '<[^>]*>|&nbsp;', '', 'g')) <> ''
)`;

// A post can keep an `unpublishedAt` stamp with `publishedAt` still set; the stamp hides it.
// `acceptableMinor` is dropped for every viewer, as the image feed does outside the pending view.
const servablePostImageSql = (browsingLevel: number) => Prisma.sql`
  (i."nsfwLevel" & ${browsingLevel}) != 0
  AND i."needsReview" IS NULL
  AND i."blockedFor" IS NULL
  AND i."acceptableMinor" = FALSE
  AND i."nsfwLevel" != ${NsfwLevel.Blocked}
  AND ${imageReviewedSql('i')}
  AND p."publishedAt" <= now()
  AND p.availability != 'Private'
  AND p."metadata"->>'unpublishedAt' IS NULL
`;

// A scalar probe, not EXISTS/JOIN: the planner would otherwise join over every image of the version.
const usedReviewedVersionSql = Prisma.sql`(SELECT true FROM "ImageResourceNew" ir
  WHERE ir."imageId" = i.id AND ir."modelVersionId" = rr."modelVersionId")`;
// A side with fewer rows than this is walked in full; at or above it, REVIEWER_WALK_CAP applies.
const SMALL_SIDE = 1000;
// Both sides are large, so only the reviewer's newest images are walked: an unbounded walk costs
// seconds for a creator with tens of thousands of images. A reviewer's matching image older than
// this window is not found, so such a review shows none (and `hasImages` can still list it).
const REVIEWER_WALK_CAP = 5000;

const COUNT_LIMIT = REVIEW_IMAGE_COUNT_CAP + 1;

type ReviewImageSet = 'count' | 'ids';

/**
 * Per review row `rr`, the published images that used its version, up to `limit`: from the
 * review's own post, or, for a review written outside a post, from any of the reviewer's posts.
 * That fallback walks whichever of the version's images or the reviewer's images is smaller (the
 * reviewer's newest `REVIEWER_WALK_CAP` when both are large).
 * `count` is how many, `ids` which ones (a post's in its own order, the rest newest first).
 */
const reviewImagesSql = (set: ReviewImageSet, limit: number, browsingLevel: number) => {
  const pick = (id: Prisma.Sql) => (set === 'count' ? Prisma.sql`1` : id);
  const order = (by: Prisma.Sql) => (set === 'count' ? Prisma.empty : Prisma.sql`ORDER BY ${by}`);
  const wrap = (rows: Prisma.Sql) =>
    set === 'count'
      ? Prisma.sql`(SELECT COUNT(*)::int FROM (${rows}) c)`
      : Prisma.sql`ARRAY(${rows})`;
  return Prisma.sql`
  CASE
    WHEN rr."postId" IS NOT NULL THEN ${wrap(Prisma.sql`
        SELECT ${pick(Prisma.sql`i.id`)} FROM "Image" i
        JOIN "Post" p ON p.id = i."postId"
        WHERE i."postId" = rr."postId" AND ${servablePostImageSql(
          browsingLevel
        )} AND ${usedReviewedVersionSql}
        ${order(Prisma.sql`i."index" NULLS LAST, i.id`)}
        LIMIT ${limit}
    `)}
    WHEN (
      SELECT COUNT(*) FROM (
        SELECT 1 FROM "ImageResourceNew" ir
        WHERE ir."modelVersionId" = rr."modelVersionId" LIMIT ${SMALL_SIDE}
      ) v
    ) < (
      SELECT COUNT(*) FROM (
        SELECT 1 FROM "Image" i WHERE i."userId" = rr."userId" LIMIT ${SMALL_SIDE}
      ) u
    ) THEN ${wrap(Prisma.sql`
        SELECT ${pick(Prisma.sql`vir."imageId"`)} FROM "ImageResourceNew" vir
        WHERE vir."modelVersionId" = rr."modelVersionId"
          AND (
            -- scalar probe, not EXISTS (see usedReviewedVersionSql)
            SELECT true FROM "Image" i
            JOIN "Post" p ON p.id = i."postId"
            WHERE i.id = vir."imageId" AND i."userId" = rr."userId" AND ${servablePostImageSql(
              browsingLevel
            )}
          )
        ${order(Prisma.sql`vir."imageId" DESC`)}
        LIMIT ${limit}
    `)}
    ELSE ${wrap(Prisma.sql`
        SELECT ${pick(Prisma.sql`i.id`)} FROM "Image" i
        JOIN (
          SELECT ri.id FROM "Image" ri WHERE ri."userId" = rr."userId"
          ORDER BY ri.id DESC LIMIT ${REVIEWER_WALK_CAP}
        ) recent ON recent.id = i.id
        JOIN "Post" p ON p.id = i."postId"
        WHERE ${servablePostImageSql(browsingLevel)} AND ${usedReviewedVersionSql}
        ${order(Prisma.sql`i.id DESC`)}
        LIMIT ${limit}
    `)}
  END
`;
};

const reviewImageCountSql = (limit: number, browsingLevel: number) =>
  reviewImagesSql('count', limit, browsingLevel);

/**
 * Whether review `rr` has a servable image from its version, for a list scoped to one version —
 * the same set `reviewImageCountSql` counts, except that this side does not apply
 * `REVIEWER_WALK_CAP`. A review with a post asks its own post; the rest look their reviewer up in
 * the `reviewers` CTE, which is read once instead of walking each reviewer's images per review.
 */
const reviewHasImagesSql = (browsingLevel: number) => Prisma.sql`
  CASE
    WHEN rr."postId" IS NOT NULL THEN EXISTS (
      SELECT 1 FROM "Image" i
      JOIN "Post" p ON p.id = i."postId"
      WHERE i."postId" = rr."postId" AND ${servablePostImageSql(
        browsingLevel
      )} AND ${usedReviewedVersionSql}
      LIMIT 1
    )
    ELSE rr."userId" IN (SELECT "userId" FROM reviewers)
  END
`;

const reviewersWithImagesCte = (modelVersionId: number, browsingLevel: number) => Prisma.sql`
  WITH reviewers AS MATERIALIZED (
    SELECT DISTINCT i."userId"
    FROM "ImageResourceNew" ir
    JOIN "Image" i ON i.id = ir."imageId"
    JOIN "Post" p ON p.id = i."postId"
    WHERE ir."modelVersionId" = ${modelVersionId} AND ${servablePostImageSql(browsingLevel)}
  )
`;

const getExcludedReviewerIds = async ({
  userId,
  modelId,
  modelVersionId,
}: {
  userId?: number;
  modelId: number;
  modelVersionId?: number;
}) => {
  const excludedUsers = await Promise.all([
    HiddenUsers.getCached({ userId }),
    BlockedByUsers.getCached({ userId }),
    BlockedUsers.getCached({ userId }),
  ]);
  // [hidden, blockedBy, blocked] — bound + dedup so a heavily-blocked viewer's
  // (unbounded) blockedBy list can't blow past Postgres's 32767 bind-param cap on
  // the raw NOT IN below (P2029). Same fix + safety-priority order as the comment
  // surfaces; see boundExcludedUserIds.
  const [hiddenUsers, blockedByUsers, blockedUsers] = excludedUsers;
  // If the viewer owns the model these reviews are on, don't hide a blocker's review/thumb
  // from them (the owner must still see + report engagement on their own content) — drop
  // blockedByUsers only then; keep the anti-harassment exclusion for every non-owner viewer.
  // Skip the lookup unless the viewer has a blocked-by list, the only case it changes anything.
  let isContentOwner = false;
  if (userId && blockedByUsers.length) {
    const model = modelVersionId
      ? (
          await dbRead.modelVersion.findUnique({
            where: { id: modelVersionId },
            select: { model: { select: { userId: true } } },
          })
        )?.model
      : await dbRead.model.findUnique({ where: { id: modelId }, select: { userId: true } });
    isContentOwner = model?.userId === userId;
  }
  return boundExcludedUserIds(
    hiddenUsers.map((u) => u.id),
    blockedByUsers.map((u) => u.id),
    blockedUsers.map((u) => u.id),
    { isContentOwner }
  );
};

const getReviewImageCounts = async (reviewIds: number[], browsingLevel: number) => {
  if (!reviewIds.length) return new Map<number, number>();
  const rows = await dbRead.$queryRaw<{ id: number; imageCount: number }[]>`
    SELECT rr.id, ${reviewImageCountSql(COUNT_LIMIT, browsingLevel)} AS "imageCount"
    FROM "ResourceReview" rr
    WHERE rr.id = ANY(${reviewIds}::int[])
  `;
  return new Map(rows.map((r) => [r.id, r.imageCount]));
};

/**
 * The ids of the images a review card shows: the ones `imageCount` counts, up to `limit`. Empty
 * for a review the viewer cannot see (a pending post's, or a hidden or blocking reviewer's).
 */
export const getReviewImageIds = async ({
  reviewId,
  limit,
  browsingLevel,
  userId,
}: {
  reviewId: number;
  limit: number;
  browsingLevel: number;
  userId?: number;
}) => {
  const [review] = await dbRead.$queryRaw<
    { userId: number; modelId: number; modelVersionId: number }[]
  >`
    SELECT rr."userId", rr."modelId", rr."modelVersionId"
    FROM "ResourceReview" rr
    WHERE rr.id = ${reviewId} AND ${visibleReviewForViewerSql('rr', userId)}
  `;
  if (!review) return [];
  const excluded = await getExcludedReviewerIds({
    userId,
    modelId: review.modelId,
    modelVersionId: review.modelVersionId,
  });
  if (excluded.includes(review.userId)) return [];

  const [row] = await dbRead.$queryRaw<{ ids: number[] }[]>`
    SELECT ${reviewImagesSql('ids', limit, browsingLevel)} AS ids
    FROM "ResourceReview" rr
    WHERE rr.id = ${reviewId}
  `;
  return row?.ids ?? [];
};

export const getPagedResourceReviews = async ({
  input,
  userId,
}: {
  input: GetResourceReviewPagedInput;
  userId?: number;
}) => {
  const {
    limit,
    page,
    modelId,
    modelVersionId,
    username,
    writtenOnly,
    hasImages,
    recommended,
    browsingLevel,
  } = input;
  const skip = page && page > 0 ? limit * (page - 1) : 0;
  const AND = [
    modelVersionId
      ? Prisma.sql`rr."modelVersionId" = ${modelVersionId}`
      : Prisma.sql`rr."modelId" = ${modelId}`,
    visibleReviewForViewerSql('rr', userId),
  ];
  if (writtenOnly) AND.push(writtenReviewSql);
  if (recommended !== undefined) AND.push(Prisma.sql`rr.recommended = ${recommended}`);
  if (hasImages) {
    if (!modelVersionId) throw throwBadRequestError('hasImages requires modelVersionId');
    AND.push(reviewHasImagesSql(browsingLevel));
  }
  if (username) {
    const user = await dbRead.user.findFirst({ where: { username }, select: { id: true } });
    if (user) AND.push(Prisma.sql`rr."userId" = ${user.id}`);
  }

  const excludedUserIds = await getExcludedReviewerIds({ userId, modelId, modelVersionId });
  if (excludedUserIds.length) {
    AND.push(Prisma.sql`rr."userId" != ALL(${excludedUserIds}::int[])`);
  }

  // writtenOnly's regex and hasImages' image probes would run on every review of the version in an
  // exact COUNT, so those paths page by hasMore (one extra row) instead.
  const pagesByHasMore = !!(writtenOnly || hasImages);
  const countQuery = pagesByHasMore
    ? undefined
    : dbRead.$queryRaw<{ count: number }[]>`
        SELECT COUNT(rr.id)::int as count
        FROM "ResourceReview" rr
        WHERE ${Prisma.join(AND, ' AND ')}
      `;
  const rowsQuery = dbRead.$queryRaw<ResourceReviewRow[]>`
    ${
      hasImages && modelVersionId
        ? reviewersWithImagesCte(modelVersionId, browsingLevel)
        : Prisma.empty
    }
    SELECT
      rr.id,
      rr."modelVersionId",
      rr."modelId",
      rr.rating,
      rr.recommended,
      rr.details,
      rr."createdAt",
      rr.nsfw,
      rr.exclude,
      rr.metadata,
      rr."userId",
      rr."postId",
      (SELECT COUNT(*)::int FROM "CommentV3" v
        WHERE ${countedTopLevelCommentSql(
          Prisma.raw('v'),
          'review'
        )} AND v."entityId" = rr.id) as "commentCount"
    FROM "ResourceReview" rr
    WHERE ${Prisma.join(AND, ' AND ')}
    ORDER BY rr."createdAt" DESC
    LIMIT ${pagesByHasMore ? limit + 1 : limit}
    OFFSET ${skip}
  `;
  const [countRows, rows] = await Promise.all([countQuery, rowsQuery]);
  const count = countRows?.[0].count;
  const hasMore = pagesByHasMore ? rows.length > limit : undefined;
  const itemsRaw = rows.slice(0, limit);

  const userIds = itemsRaw.map((item) => item.userId);
  const [users, userCosmetics, profilePictures, imageCounts] = await Promise.all([
    getBasicDataForUsers(userIds),
    getCosmeticsForUsers(userIds),
    getProfilePicturesForUsers(userIds),
    getReviewImageCounts(
      itemsRaw.map((item) => item.id),
      browsingLevel
    ),
  ]);
  const items = itemsRaw.map(({ userId, ...item }) => {
    const user = users[userId];
    return {
      ...item,
      imageCount: imageCounts.get(item.id) ?? 0,
      user: {
        id: userId,
        username: user.username,
        userImage: user.image,
        deletedAt: user.deletedAt,
        cosmetics: userCosmetics?.[userId] ?? [],
        profilePicture: profilePictures?.[userId] ?? null,
      },
    };
  });

  return getPagingData({ items, count, hasMore }, limit, page);
};

export const toggleExcludeResourceReview = async ({ id }: GetByIdInput) => {
  const item = await dbRead.resourceReview.findUnique({ where: { id }, select: { exclude: true } });
  if (!item) throw throwNotFoundError();

  const ret = await dbWrite.resourceReview.update({
    where: { id },
    data: { exclude: !item.exclude },
    select: {
      id: true,
      modelId: true,
      modelVersionId: true,
      rating: true,
      recommended: true,
      nsfw: true,
      exclude: true,
    },
  });
  await bustRatingTotalsCache({
    modelId: ret.modelId,
    modelVersionId: ret.modelVersionId,
  }).catch();
  return ret;
};

export const getUserRatingTotals = async ({ userId }: { userId: number }) => {
  const result = await dbRead.$queryRaw<{ rating: number; recommended: boolean; count: number }[]>`
    SELECT
      rr.rating,
      rr.recommended,
      COUNT(rr.id)::int count
    FROM "ResourceReview" rr
    JOIN "Model" m ON rr."modelId" = m.id AND m."userId" = ${userId}
    WHERE rr."userId" != ${userId} AND NOT rr.exclude
      AND ${Prisma.raw(visibleReviewSql('rr'))}
    GROUP BY rr.rating, rr.recommended
  `;

  const transformed = result.reduce(
    (acc, { rating, recommended, count }) => {
      const key = rating.toString() as keyof RatingTotalsModel;
      if (acc[key] !== undefined) acc[key] = count;
      // Need to check explicitly because of null
      if (recommended === true) acc.up += count;
      else if (recommended === false) acc.down += count;

      return acc;
    },
    { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, up: 0, down: 0 }
  );

  return transformed;
};
