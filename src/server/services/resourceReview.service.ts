import { throwNotFoundError } from '~/server/utils/errorHandling';
import { getReactionsSelect } from './../selectors/reaction.selector';
import {
  GetResourceReviewsInfiniteInput,
  GetRatingTotalsInput,
} from './../schema/resourceReview.schema';
import { GetByIdInput } from '~/server/schema/base.schema';
import { UpsertResourceReviewInput } from '../schema/resourceReview.schema';
import { dbWrite, dbRead } from '~/server/db/client';
import { GetResourceReviewsInput } from '~/server/schema/resourceReview.schema';
import { Prisma } from '@prisma/client';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';

export type ResourceReviewDetailModel = AsyncReturnType<typeof getResourceReview>;
export const getResourceReview = async ({ id }: GetByIdInput) => {
  const result = await dbRead.resourceReview.findUnique({
    where: { id },
    select: {
      id: true,
      thread: {
        select: {
          _count: { select: { comments: true } },
        },
      },
      model: { select: { name: true, id: true, userId: true } },
      modelVersion: { select: { name: true, id: true } },
      details: true,
      createdAt: true,
      rating: true,
      user: { select: userWithCosmeticsSelect },
      helper: { select: { imageCount: true } },
    },
  });
  if (!result) throw throwNotFoundError();
  return result;
};

export const getResourceReviews = async ({ resourceIds }: GetResourceReviewsInput) => {
  return await dbWrite.resourceReview.findMany({
    where: { modelVersionId: { in: resourceIds } },
    select: {
      id: true,
      modelVersionId: true,
      rating: true,
      details: true,
    },
  });
};

export const getResourceReviewsInfinite = async ({
  limit,
  cursor,
  modelId,
  modelVersionId,
}: GetResourceReviewsInfiniteInput) => {
  const AND: Prisma.Enumerable<Prisma.ResourceReviewWhereInput> = [];
  const orderBy: Prisma.Enumerable<Prisma.ResourceReviewOrderByWithRelationInput> = [];

  if (modelId) AND.push({ modelId });
  if (modelVersionId) AND.push({ modelVersionId });
  AND.push({ details: { not: null } });

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
      user: { select: userWithCosmeticsSelect },
      helper: { select: { imageCount: true } },
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

export type RatingTotalsModel = { '1': number; '2': number; '3': number; '4': number; '5': number };
export const getRatingTotals = async ({ modelVersionId }: GetRatingTotalsInput) => {
  const result = await dbRead.$queryRaw<{ rating: number; count: number }[]>`
    SELECT
      rr.rating,
      COUNT(*)::int count
    FROM "ResourceReview" rr
    WHERE rr."modelVersionId" = ${modelVersionId}
    GROUP BY rr.rating
  `;

  const transformed = result.reduce(
    (acc, { rating, count }) => {
      const key = rating.toString() as keyof RatingTotalsModel;
      if (acc[key] !== undefined) acc[key] = count;
      return acc;
    },
    { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }
  );
  return transformed;
};

export const upsertResourceReview = async (
  data: UpsertResourceReviewInput & { userId: number }
) => {
  if (!data.id)
    return await dbWrite.resourceReview.create({
      data: { ...data, thread: { create: {} } },
      select: { id: true },
    });
  else
    return await dbWrite.resourceReview.update({
      where: { id: data.id },
      data,
      select: { id: true },
    });
};

export const deleteResourceReview = async ({ id }: GetByIdInput) => {
  return await dbWrite.resourceReview.delete({ where: { id } });
};
