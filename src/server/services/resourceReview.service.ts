import { Prisma } from '@prisma/client';
import { CacheTTL } from '~/server/common/constants';
import { NotificationCategory } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';

import { getDbWithoutLag } from '~/server/db/db-lag-helpers';
import { logToAxiom } from '~/server/logging/client';
import type { GetByIdInput } from '~/server/schema/base.schema';
import type { GetResourceReviewsInput } from '~/server/schema/resourceReview.schema';
import {
  resourceReviewSelect,
  resourceReviewSimpleSelect,
} from '~/server/selectors/resourceReview.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { throwOnBlockedLinkDomain } from '~/server/services/blocklist.service';
import { createNotification } from '~/server/services/notification.service';
import {
  BlockedByUsers,
  BlockedUsers,
  HiddenUsers,
} from '~/server/services/user-preferences.service';
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
import { throwAuthorizationError, throwNotFoundError } from '~/server/utils/errorHandling';
import { getPagingData } from '~/server/utils/pagination-helpers';
import type { ResourceReviewCreate } from '~/types/router';
import type { UpsertResourceReviewInput } from '../schema/resourceReview.schema';
import type {
  CreateResourceReviewInput,
  GetRatingTotalsInput,
  GetResourceReviewPagedInput,
  GetResourceReviewsInfiniteInput,
  GetUserResourceReviewInput,
  UpdateResourceReviewInput,
} from './../schema/resourceReview.schema';

export type ResourceReviewDetailModel = AsyncReturnType<typeof getResourceReview>;
export const getResourceReview = async ({
  id,
  userId,
  isModerator,
}: GetByIdInput & { userId?: number; isModerator?: boolean }) => {
  const result = await dbRead.resourceReview.findUnique({
    where: { id },
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

  return result;
};

export const getUserResourceReview = async ({
  modelId,
  modelVersionId,
  userId,
  tx,
}: GetUserResourceReviewInput & { userId: number; tx?: Prisma.TransactionClient }) => {
  if (!userId) throw throwAuthorizationError();
  const dbClient = tx ?? (await getDbWithoutLag('resourceReview', userId));
  const results = await dbClient.resourceReview.findMany({
    where: { modelId, modelVersionId, userId },
    select: resourceReviewSimpleSelect,
  });
  if (!results) return null;

  return results;
};

export const getResourceReviewsByUserId = ({
  userId,
  recommended,
}: {
  userId: number;
  recommended?: boolean;
}) => {
  return dbRead.resourceReview.findMany({
    where: { userId, recommended },
    select: { modelId: true, modelVersionId: true },
  });
};

export const getResourceReviews = async ({ resourceIds }: GetResourceReviewsInput) => {
  return await dbRead.resourceReview.findMany({
    where: { modelVersionId: { in: resourceIds } },
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
}: GetResourceReviewsInfiniteInput) => {
  const AND: Prisma.Enumerable<Prisma.ResourceReviewWhereInput> = [];
  const orderBy: Prisma.Enumerable<Prisma.ResourceReviewOrderByWithRelationInput> = [];

  if (username) {
    const userFindArgs = { where: { username }, select: { id: true } };
    const targetUser =
      (await dbRead.user.findUnique(userFindArgs)) ??
      (await dbWrite.user.findUnique(userFindArgs));

    if (!targetUser) throw new Error('User not found');

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
      thread: {
        select: {
          commentCount: true,
        },
      },
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

  return {
    nextCursor,
    items,
  };
};

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
      AND rr.recommended -- Only expose recommended reviews
    GROUP BY rr.rating, rr.recommended
  `;

  const cacheable = queryCache(dbRead, 'getRatingTotals', 'v1');
  const result = await cacheable<GetRatingTotalsRow[]>(query, {
    ttl: CacheTTL.hour,
    tag: modelVersionId
      ? [`rating:modelVersion:${modelVersionId}`]
      : [`rating:model:${modelId}`],
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

const createResourceReviewNotification = async ({
  id,
  modelId,
  modelVersionId,
  recommended,
  userId,
}: ResourceReviewCreate & { userId: number }) => {
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

export const upsertResourceReview = async ({
  userId,
  ...data
}: UpsertResourceReviewInput & { userId: number }) => {
  if (data.details) await throwOnBlockedLinkDomain(data.details);
  if (!data.id) {
    const ret = await dbWrite.resourceReview.create({
      data: { ...data, userId, thread: { create: {} } },
      select: resourceReviewSelect,
    });
    await createResourceReviewNotification({ ...ret, userId }).catch();
    await bustRatingTotalsCache({
      modelId: data.modelId,
      modelVersionId: data.modelVersionId,
    }).catch();
    return ret;
  } else {
    const ret = await dbWrite.resourceReview.update({
      where: { id: data.id },
      data,
      select: { id: true, modelId: true, modelVersionId: true },
    });
    await bustRatingTotalsCache({
      modelId: ret.modelId,
      modelVersionId: ret.modelVersionId,
    }).catch();
    return ret;
  }
};

export const deleteResourceReview = async ({ id }: GetByIdInput) => {
  // Prisma .delete() returns the full deleted row by default — caller in
  // resourceReview.controller.ts already relies on this — so we use modelId
  // and modelVersionId from the returned row rather than pre-fetching.
  const ret = await dbWrite.resourceReview.delete({ where: { id } });
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
  // Fetch model/version ids BEFORE the delete so we can bust the rating-totals
  // cache after.
  const affected = await dbRead.resourceReview.findMany({
    where: { id: { in: ids } },
    select: { modelId: true, modelVersionId: true },
  });
  const result = await dbWrite.resourceReview.deleteMany({
    where: { id: { in: ids } },
  });
  await bustRatingTotalsForRows(affected).catch();
  return { count: result.count };
}

export const createResourceReview = async (
  data: CreateResourceReviewInput & { userId: number }
) => {
  const ret = await dbWrite.resourceReview.create({ data, select: resourceReviewSimpleSelect });
  await createResourceReviewNotification({ ...ret, userId: data.userId }).catch();
  await bustRatingTotalsCache({
    modelId: data.modelId,
    modelVersionId: data.modelVersionId,
  }).catch();
  return ret;
};

export const updateResourceReview = async ({ id, ...data }: UpdateResourceReviewInput) => {
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
    },
  });
  await bustRatingTotalsCache({
    modelId: ret.modelId,
    modelVersionId: ret.modelVersionId,
  }).catch();
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
  imageCount: number;
  commentCount: number;
};
export const getPagedResourceReviews = async ({
  input,
  userId,
}: {
  input: GetResourceReviewPagedInput;
  userId?: number;
}) => {
  const { limit, page, modelVersionId, username } = input;
  const skip = page && page > 0 ? limit * (page - 1) : 0;
  const AND = [Prisma.sql`rr."modelVersionId" = ${modelVersionId}`];
  if (username) {
    const user = await dbRead.user.findFirst({ where: { username }, select: { id: true } });
    if (user) AND.push(Prisma.sql`rr."userId" = ${user.id}`);
  }

  const excludedUsers = await Promise.all([
    HiddenUsers.getCached({ userId }),
    BlockedByUsers.getCached({ userId }),
    BlockedUsers.getCached({ userId }),
  ]);
  const excludedUserIds = [...new Set(excludedUsers.flat().map((user) => user.id))];
  if (excludedUserIds.length) {
    AND.push(Prisma.sql`rr."userId" NOT IN (${Prisma.join(excludedUserIds)})`);
  }

  const [{ count }] = await dbRead.$queryRaw<{ count: number }[]>`
    SELECT COUNT(rr.id)::int as count
    FROM "ResourceReview" rr
    WHERE ${Prisma.join(AND, ' AND ')}
  `;
  const itemsRaw = await dbRead.$queryRaw<ResourceReviewRow[]>`
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
      -- TODO: This is a temporary fix until we can figure out a more performant way to get the count
      -- (
      --   SELECT "imageCount"::int
      --   FROM "ResourceReviewHelper" rrh
      --   WHERE rrh."resourceReviewId" = rr.id
      -- ) "imageCount",
      COALESCE(t."commentCount", 0)::int as "commentCount"
    FROM "ResourceReview" rr
    LEFT JOIN "Thread" t ON t."reviewId" = rr.id
    WHERE ${Prisma.join(AND, ' AND ')}
    ORDER BY rr."createdAt" DESC
    LIMIT ${limit}
    OFFSET ${skip}
  `;

  const userIds = itemsRaw.map((item) => item.userId);
  const users = await getBasicDataForUsers(userIds);
  const userCosmetics = await getCosmeticsForUsers(userIds);
  const profilePictures = await getProfilePicturesForUsers(userIds);
  const items = itemsRaw
    .map(({ userId, imageCount = 0, ...item }) => {
      let quality = 0;
      if (item.details && item.details.length > 0) quality++;
      if (imageCount > 0) quality++;
      const user = users[userId];
      return {
        ...item,
        imageCount,
        quality,
        user: {
          id: userId,
          username: user.username,
          userImage: user.image,
          deletedAt: user.deletedAt,
          cosmetics: userCosmetics?.[userId] ?? [],
          profilePicture: profilePictures?.[userId] ?? null,
        },
      };
    })
    .sort((a, b) => b.quality - a.quality);

  return getPagingData({ items, count }, limit, page);
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
