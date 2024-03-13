import { throwAuthorizationError, throwNotFoundError } from '~/server/utils/errorHandling';
import {
  CreateResourceReviewInput,
  GetRatingTotalsInput,
  GetResourceReviewPagedInput,
  GetResourceReviewsInfiniteInput,
  GetUserResourceReviewInput,
  UpdateResourceReviewInput,
} from './../schema/resourceReview.schema';
import { GetByIdInput } from '~/server/schema/base.schema';
import { UpsertResourceReviewInput } from '../schema/resourceReview.schema';
import { dbRead, dbWrite } from '~/server/db/client';
import { GetResourceReviewsInput } from '~/server/schema/resourceReview.schema';
import { Prisma } from '@prisma/client';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { getPagedData, getPagingData } from '~/server/utils/pagination-helpers';
import {
  resourceReviewSelect,
  resourceReviewSimpleSelect,
} from '~/server/selectors/resourceReview.selector';
import { ReviewSort } from '~/server/common/enums';
import { getCosmeticsForUsers, getProfilePicturesForUsers } from '~/server/services/user.service';

export type ResourceReviewDetailModel = AsyncReturnType<typeof getResourceReview>;
export const getResourceReview = async ({ id, userId }: GetByIdInput & { userId?: number }) => {
  const result = await dbRead.resourceReview.findUnique({
    where: { id },
    select: {
      ...resourceReviewSelect,
      model: { select: { name: true, id: true, userId: true, status: true } },
    },
  });
  if (!result || result.model.status !== 'Published') throw throwNotFoundError();

  return result;
};

export const getUserResourceReview = async ({
  modelId,
  modelVersionId,
  userId,
}: GetUserResourceReviewInput & { userId: number }) => {
  if (!userId) throw throwAuthorizationError();
  const results = await dbRead.resourceReview.findMany({
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
    const targetUser = await dbRead.user.findUnique({
      where: { username },
      select: { id: true },
    });

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
          _count: { select: { comments: true } },
        },
      },
      modelId: true,
      modelVersionId: true,
      details: true,
      createdAt: true,
      rating: true,
      recommended: true,
      user: { select: userWithCosmeticsSelect },
      helper: { select: { imageCount: true } },
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

  const result = await dbRead.$queryRaw<GetRatingTotalsRow[]>`
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

export const upsertResourceReview = ({
  userId,
  ...data
}: UpsertResourceReviewInput & { userId: number }) => {
  if (!data.id)
    return dbWrite.resourceReview.create({
      data: { ...data, userId, thread: { create: {} } },
      select: resourceReviewSelect,
    });
  else
    return dbWrite.resourceReview.update({
      where: { id: data.id },
      data,
      select: { id: true },
    });
};

export const deleteResourceReview = ({ id }: GetByIdInput) => {
  return dbWrite.resourceReview.delete({ where: { id } });
};

export const createResourceReview = (data: CreateResourceReviewInput & { userId: number }) => {
  return dbWrite.resourceReview.create({ data, select: resourceReviewSimpleSelect });
};

export const updateResourceReview = ({ id, ...data }: UpdateResourceReviewInput) => {
  return dbWrite.resourceReview.update({
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
  username: string;
  deletedAt: Date | null;
  userImage: string | null;
  imageCount: number;
  commentCount: number;
};
export const getPagedResourceReviews = async (input: GetResourceReviewPagedInput) => {
  const { limit, page, modelVersionId, username } = input;
  const skip = limit * (page - 1);
  const AND = [Prisma.sql`rr."modelVersionId" = ${modelVersionId}`];
  if (username) AND.push(Prisma.sql`u.username = ${username}`);

  const [{ count }] = await dbRead.$queryRaw<{ count: number }[]>`
    SELECT COUNT(rr.id)::int as count
    FROM "ResourceReview" rr
    JOIN "User" u ON rr."userId" = u.id
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
      u.username,
      u."deletedAt",
      u.image as "userImage",
      (
        SELECT "imageCount"::int
        FROM "ResourceReviewHelper" rrh
        WHERE rrh."resourceReviewId" = rr.id
      ) "imageCount",
      (
        SELECT COUNT(*)::int
        FROM "Thread" t
        JOIN "CommentV2" c ON c."threadId" = t.id
        WHERE t."reviewId" = rr.id
      ) "commentCount"
    FROM "ResourceReview" rr
    JOIN "User" u ON rr."userId" = u.id
    WHERE ${Prisma.join(AND, ' AND ')}
    ORDER BY rr."createdAt" DESC
    LIMIT ${limit}
    OFFSET ${skip}
  `;

  const userIds = itemsRaw.map((item) => item.userId);
  const userCosmetics = await getCosmeticsForUsers(userIds);
  const profilePictures = await getProfilePicturesForUsers(userIds);
  const items = itemsRaw
    .map(({ userId, username, userImage, deletedAt, ...item }) => {
      let quality = 0;
      if (item.details && item.details.length > 0) quality++;
      if (item.imageCount > 0) quality++;
      return {
        ...item,
        quality,
        user: {
          id: userId,
          username,
          userImage,
          deletedAt,
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

  return await dbWrite.resourceReview.update({
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
