import { Prisma, ReviewReactions } from '@prisma/client';
import { SessionUser } from 'next-auth';

import { env } from '~/env/server.mjs';
import { ReviewFilter, ReviewSort } from '~/server/common/enums';
import { prisma } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import {
  GetAllReviewsInput,
  GetReviewReactionsInput,
  ReviewUpsertInput,
} from '~/server/schema/review.schema';
import { getReactionsSelect } from '~/server/selectors/reaction.selector';
import { getAllReviewsSelect } from '~/server/selectors/review.selector';
import { DEFAULT_PAGE_SIZE } from '~/server/utils/pagination-helpers';

export const getReviews = <TSelect extends Prisma.ReviewSelect>({
  input: {
    limit = DEFAULT_PAGE_SIZE,
    page,
    cursor,
    modelId,
    modelVersionId,
    userId,
    filterBy,
    sort,
  },
  user,
  select,
}: {
  input: GetAllReviewsInput;
  select: TSelect;
  user?: SessionUser;
}) => {
  const skip = page ? (page - 1) * limit : undefined;
  // const canViewNsfw = user?.showNsfw ?? env.UNAUTHENTICATE_LIST_NSFW;

  return prisma.review.findMany({
    take: limit,
    skip,
    cursor: cursor ? { id: cursor } : undefined,
    where: {
      modelId,
      modelVersionId,
      userId,
      // imagesOnReviews: filterBy?.includes(ReviewFilter.IncludesImages) ? { some: {} } : undefined,
      // OR: user
      //   ? [
      //       {
      //         userId: { not: user.id },
      //         nsfw: canViewNsfw
      //           ? filterBy?.includes(ReviewFilter.NSFW)
      //             ? true
      //             : undefined
      //           : false,
      //       },
      //       { userId: user.id },
      //     ]
      //   : undefined,
    },
    orderBy: {
      createdAt:
        sort === ReviewSort.Oldest ? 'asc' : sort === ReviewSort.Newest ? 'desc' : undefined,
      reactions: sort === ReviewSort.MostLiked ? { _count: 'desc' } : undefined,
      comments: sort === ReviewSort.MostComments ? { _count: 'desc' } : undefined,
    },
    select,
  });
};

export const getReviewById = <TSelect extends Prisma.ReviewSelect>({
  id,
  select,
}: GetByIdInput & { select: TSelect }) => {
  return prisma.review.findUnique({
    where: { id },
    select,
  });
};

export const getReviewReactions = ({ reviewId }: GetReviewReactionsInput) => {
  return prisma.reviewReaction.findMany({
    where: { reviewId },
    select: getReactionsSelect,
  });
};

export const getUserReactionByReviewId = ({
  reaction,
  userId,
  reviewId,
}: {
  reaction: ReviewReactions;
  userId: number;
  reviewId: number;
}) => {
  return prisma.reviewReaction.findFirst({ where: { reaction, userId, reviewId } });
};

export const createOrUpdateReview = async ({
  ownerId,
  ...input
}: ReviewUpsertInput & { ownerId: number }) => {
  const { images = [], id, ...reviewInput } = input;
  const imagesWithIndex = images.map((image, index) => ({
    userId: ownerId,
    ...image,
    meta: (image.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
    index,
  }));

  const imagesToUpdate = imagesWithIndex.filter((x) => !!x.id);
  const imagesToCreate = imagesWithIndex.filter((x) => !x.id);

  return await prisma.$transaction(async (tx) => {
    await Promise.all(
      // extract index because index is not a part of the prisma schema for this model
      imagesToUpdate.map(async ({ index, ...image }) =>
        tx.image.updateMany({
          where: { id: image.id },
          data: {
            ...image,
            meta: (image.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
          },
        })
      )
    );

    return prisma.review.upsert({
      where: { id: id ?? -1 },
      create: {
        ...reviewInput,
        userId: ownerId,
        imagesOnReviews: {
          create: imagesWithIndex.map(({ index, ...image }) => ({
            index,
            image: { create: image },
          })),
        },
      },
      update: {
        ...reviewInput,
        imagesOnReviews: {
          deleteMany: {
            NOT: imagesToUpdate.map((image) => ({ imageId: image.id })),
          },
          create: imagesToCreate.map(({ index, ...image }) => ({
            index,
            image: { create: image },
          })),
          update: imagesToUpdate.map(({ index, ...image }) => ({
            where: {
              imageId_reviewId: {
                imageId: image.id as number,
                reviewId: input.id as number,
              },
            },
            data: { index },
          })),
        },
      },
      select: {
        id: true,
        modelId: true,
      },
    });
  });
};

export const deleteReviewById = ({ id }: GetByIdInput) => {
  return prisma.review.delete({
    where: { id },
  });
};

export const updateReviewById = ({ id, data }: { id: number; data: Prisma.ReviewUpdateInput }) => {
  return prisma.review.update({ where: { id }, data, select: getAllReviewsSelect() });
};
