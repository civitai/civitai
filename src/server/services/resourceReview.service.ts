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
import { getPagedData } from '~/server/utils/pagination-helpers';
import { resourceReviewSelect } from '~/server/selectors/resourceReview.selector';
import { ReviewSort } from '~/server/common/enums';

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
  modelVersionId,
  userId,
}: GetUserResourceReviewInput & { userId: number }) => {
  if (!userId) throw throwAuthorizationError();
  const result = await dbRead.resourceReview.findFirst({
    where: { modelVersionId, userId },
    select: resourceReviewSelect,
  });
  if (!result) return null;

  return result;
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
export const getRatingTotals = async ({ modelVersionId, modelId }: GetRatingTotalsInput) => {
  const AND: Prisma.Sql[] = [Prisma.sql`rr."modelId" = ${modelId}`];
  if (modelVersionId) AND.push(Prisma.sql`rr."modelVersionId" = ${modelVersionId}`);

  const result = await dbRead.$queryRaw<
    { rating: number; recommended: boolean | null; count: number }[]
  >`
    SELECT
      rr.rating,
      rr.recommended,
      COUNT(rr.id)::int count
    FROM "ResourceReview" rr
    JOIN "Model" m ON rr."modelId" = m.id AND m."userId" != rr."userId"
    WHERE ${Prisma.join(AND, ' AND ')} AND NOT rr.exclude
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
  return dbWrite.resourceReview.create({ data, select: resourceReviewSelect });
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

export const getPagedResourceReviews = async (input: GetResourceReviewPagedInput) => {
  return await getPagedData(input, async ({ skip, take, modelId, modelVersionId, username }) => {
    const AND: Prisma.Enumerable<Prisma.ResourceReviewWhereInput> = [{ modelId, modelVersionId }];
    if (username) AND.push({ user: { username } });

    const count = await dbRead.resourceReview.count({ where: { AND } });
    const items = await dbRead.resourceReview.findMany({
      skip,
      take,
      where: { AND },
      orderBy: { createdAt: 'desc' },
      select: resourceReviewSelect,
    });

    return { items, count };
  });
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
    GROUP BY rr.rating
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
