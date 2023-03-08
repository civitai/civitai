import { prepareUpdateImage } from './../selectors/image.selector';
import { prepareCreateImage } from '~/server/selectors/image.selector';
import { Prisma, ReportReason, ReportStatus, Review, ReviewReactions } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { SessionUser } from 'next-auth';

import { ReviewSort } from '~/server/common/enums';
import { dbWrite, dbRead } from '~/server/db/client';
import { queueMetricUpdate } from '~/server/jobs/update-metrics';
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
  input: { limit = DEFAULT_PAGE_SIZE, page, cursor, modelId, modelVersionId, userId, sort },
  select,
  user,
}: {
  input: GetAllReviewsInput;
  select: TSelect;
  user?: SessionUser;
}) => {
  const skip = page ? (page - 1) * limit : undefined;
  const isMod = user?.isModerator ?? false;
  // const canViewNsfw = user?.showNsfw ?? env.UNAUTHENTICATED_LIST_NSFW;

  return dbRead.review.findMany({
    take: limit,
    skip,
    cursor: cursor ? { id: cursor } : undefined,
    where: {
      modelId,
      modelVersionId,
      userId,
      tosViolation: !isMod ? false : undefined,
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
  user,
}: GetByIdInput & { select: TSelect; user?: SessionUser }) => {
  const isMod = user?.isModerator ?? false;

  return dbRead.review.findFirst({
    where: { id, tosViolation: !isMod ? false : undefined },
    select,
  });
};

export const getReviewReactions = ({ reviewId }: GetReviewReactionsInput) => {
  return dbRead.reviewReaction.findMany({
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
  return dbRead.reviewReaction.findFirst({ where: { reaction, userId, reviewId } });
};

export const createOrUpdateReview = async ({
  ownerId,
  ...input
}: ReviewUpsertInput & { ownerId: number; locked: boolean }) => {
  const { images = [], id, locked, ...reviewInput } = input;

  // If we are editing, but the review is locked
  // prevent from updating
  if (id && locked)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'This review is locked and cannot be updated',
    });

  const imagesWithIndex = images.map((image, index) => ({
    userId: ownerId,
    ...image,
    meta: (image.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
    index,
  }));

  const imagesToUpdate = imagesWithIndex.filter((x) => !!x.id);
  const imagesToCreate = imagesWithIndex.filter((x) => !x.id);

  return dbWrite.review.upsert({
    where: { id: id ?? -1 },
    create: {
      ...reviewInput,
      userId: ownerId,
      imagesOnReviews: {
        create: imagesWithIndex.map(({ index, ...image }) => ({
          index,
          image: {
            create: {
              userId: ownerId,
              ...prepareCreateImage(image),
            },
          },
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
          image: {
            create: {
              userId: ownerId,
              ...prepareCreateImage(image),
            },
          },
        })),
        update: imagesToUpdate.map(({ index, ...image }) => ({
          where: {
            imageId_reviewId: {
              imageId: image.id as number,
              reviewId: input.id as number,
            },
          },
          data: {
            index,
            image: { update: prepareUpdateImage(image) },
          },
        })),
      },
    },
    select: {
      id: true,
      modelId: true,
    },
  });
};

export const deleteReviewById = async ({ id }: GetByIdInput) => {
  const { modelId, model } =
    (await dbWrite.review.findUnique({
      where: { id },
      select: { modelId: true, model: { select: { userId: true } } },
    })) ?? {};

  await dbWrite.review.delete({ where: { id } });
  if (modelId) await queueMetricUpdate('Model', modelId);
  if (model?.userId) await queueMetricUpdate('User', model.userId);
};

export const updateReviewById = ({ id, data }: { id: number; data: Prisma.ReviewUpdateInput }) => {
  return dbWrite.review.update({ where: { id }, data, select: getAllReviewsSelect() });
};

export const convertReviewToComment = ({
  id,
  text,
  modelId,
  userId,
  createdAt,
}: Pick<DeepNonNullable<Review>, 'id' | 'text' | 'modelId' | 'userId' | 'createdAt'>) => {
  return dbWrite.$transaction(async (tx) => {
    const reviewReactions = await tx.reviewReaction.findMany({
      where: { reviewId: id },
      select: { reaction: true, userId: true, createdAt: true },
    });
    const comment = await tx.comment.create({
      data: {
        content: text,
        modelId,
        userId,
        createdAt,
        reactions: { createMany: { data: reviewReactions } },
      },
    });

    await tx.comment.updateMany({
      where: { modelId, reviewId: id, parentId: null },
      data: { parentId: comment.id, reviewId: null },
    });

    await tx.review.delete({ where: { id } });
    await queueMetricUpdate('Model', modelId);

    return comment;
  });
};

export const updateReviewReportStatusByReason = ({
  id,
  reason,
  status,
}: {
  id: number;
  reason: ReportReason;
  status: ReportStatus;
}) => {
  return dbWrite.$transaction(async (tx) => {
    await dbWrite.report.updateMany({
      where: { reason, review: { reviewId: id } },
      data: { status },
    });

    if (status === ReportStatus.Actioned) {
      if (reason === ReportReason.TOSViolation)
        await tx.image.updateMany({
          where: { imagesOnReviews: { reviewId: id } },
          data: { tosViolation: true },
        });
      else if (reason === ReportReason.NSFW)
        await tx.image.updateMany({
          where: { imagesOnReviews: { reviewId: id } },
          data: { nsfw: true },
        });
    }
  });
};
