import { Prisma, ReportReason, ReviewReactions } from '@prisma/client';
import { SessionUser } from 'next-auth';

import { ReviewFilter, ReviewSort } from '~/server/common/enums';
import { prisma } from '~/server/db/client';
import { GetByIdInput, ReportInput } from '~/server/schema/base.schema';
import {
  GetAllReviewsInput,
  GetReviewReactionsInput,
  ReviewUpsertInput,
} from '~/server/schema/review.schema';
import { getAllReviewsSelect, getReactionsSelect } from '~/server/selectors/review.selector';

export const getReviews = async <TSelect extends Prisma.ReviewSelect>({
  input: { limit, page, cursor, modelId, modelVersionId, userId, filterBy, sort },
  user,
  select,
}: {
  input: GetAllReviewsInput;
  user?: SessionUser;
  select: TSelect;
}) => {
  const take = limit ?? 10;
  const skip = page ? (page - 1) * take : undefined;
  const canViewNsfw = user?.showNsfw
    ? filterBy?.includes(ReviewFilter.NSFW)
      ? true
      : undefined
    : false;

  return await prisma.review.findMany({
    take,
    skip,
    cursor: cursor ? { id: cursor } : undefined,
    where: {
      modelId,
      modelVersionId,
      userId,
      nsfw: !canViewNsfw ? { equals: false } : undefined,
      imagesOnReviews: filterBy?.includes(ReviewFilter.IncludesImages) ? { some: {} } : undefined,
    },
    orderBy: {
      createdAt:
        sort === ReviewSort.Oldest ? 'asc' : sort === ReviewSort.Newest ? 'desc' : undefined,
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

export const reportReviewById = ({ id, reason, userId }: ReportInput & { userId: number }) => {
  const data: Prisma.ReviewUpdateInput =
    reason === ReportReason.NSFW ? { nsfw: true } : { tosViolation: true };

  return prisma.$transaction([
    prisma.review.update({ where: { id }, data }),
    prisma.modelReport.create({
      data: {
        modelId: id,
        reason,
        userId,
      },
    }),
  ]);
};

export const deleteUserReviewById = ({ id, userId }: GetByIdInput & { userId: number }) => {
  return prisma.review.deleteMany({
    where: { AND: { id, userId } },
  });
};

export const updateReviewById = ({ id, data }: { id: number; data: Prisma.ReviewUpdateInput }) => {
  return prisma.review.update({ where: { id }, data, select: getAllReviewsSelect });
};
