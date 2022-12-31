import { TRPCError } from '@trpc/server';

import { Context } from '~/server/createContext';
import { GetByIdInput } from '~/server/schema/base.schema';
import {
  GetAllReviewsInput,
  GetReviewReactionsInput,
  ReviewUpsertInput,
  ToggleReacionInput,
} from '~/server/schema/review.schema';
import { commentDetailSelect } from '~/server/selectors/comment.selector';
import { getAllReviewsSelect, reviewDetailSelect } from '~/server/selectors/review.selector';
import {
  getReviewReactions,
  getReviews,
  createOrUpdateReview,
  deleteReviewById,
  getUserReactionByReviewId,
  updateReviewById,
  getReviewById,
} from '~/server/services/review.service';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';

export const getReviewsInfiniteHandler = async ({
  input,
  ctx,
}: {
  input: GetAllReviewsInput;
  ctx: Context;
}) => {
  input.limit = input.limit ?? 20;
  const limit = input.limit + 1;

  const reviews = await getReviews({
    input: { ...input, limit },
    user: ctx.user,
    select: getAllReviewsSelect,
  });

  let nextCursor: number | undefined;
  if (reviews.length > input.limit) {
    const nextItem = reviews.pop();
    nextCursor = nextItem?.id;
  }

  return {
    nextCursor,
    reviews: reviews.map(({ imagesOnReviews, ...review }) => ({
      ...review,
      images: imagesOnReviews.map(({ image }) => image),
    })),
  };
};

export const getReviewReactionsHandler = async ({ input }: { input: GetReviewReactionsInput }) => {
  try {
    const reactions = await getReviewReactions(input);

    return reactions;
  } catch (error) {
    throwDbError(error);
  }
};

export const upsertReviewHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context> & { ownerId: number };
  input: ReviewUpsertInput;
}) => {
  try {
    const { ownerId } = ctx;
    const review = await createOrUpdateReview({ ...input, ownerId });

    return review;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const deleteUserReviewHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: GetByIdInput;
}) => {
  try {
    const deleted = await deleteReviewById({ ...input });
    if (!deleted) {
      throw throwNotFoundError(`No review with id ${input.id}`);
    }

    return deleted;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
};

export const toggleReactionHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: ToggleReacionInput;
}) => {
  const { user } = ctx;
  const { id, reaction } = input;

  const reviewReaction = await getUserReactionByReviewId({
    reaction,
    reviewId: id,
    userId: user.id,
  });

  try {
    const review = await updateReviewById({
      id,
      data: {
        reactions: {
          create: reviewReaction ? undefined : { reaction, userId: user.id },
          deleteMany: reviewReaction ? { reaction, userId: user.id } : undefined,
        },
      },
    });

    if (!review) {
      throw throwNotFoundError(`No review with id ${id}`);
    }

    return review;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
};

export const toggleExcludeHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: GetByIdInput;
}) => {
  const { user } = ctx;
  const { id } = input;

  const { exclude } = (await getReviewById({ id, select: { exclude: true } })) ?? {};

  try {
    const review = await updateReviewById({
      id,
      data: {
        exclude: !exclude,
      },
    });

    if (!review) {
      throw throwNotFoundError(`No review with id ${id}`);
    }

    return review;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
};

export type ReviewDetails = AsyncReturnType<typeof getReviewDetailsHandler>;
export const getReviewDetailsHandler = async ({ input: { id } }: { input: GetByIdInput }) => {
  try {
    const result = await getReviewById({
      id,
      select: reviewDetailSelect,
    });

    if (!result) throw throwNotFoundError(`No review with id ${id}`);

    const { imagesOnReviews, ...review } = result;
    return {
      ...review,
      images: imagesOnReviews.map((x) => x.image),
    };
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getReviewCommentsHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    const review = await getReviewById({
      ...input,
      select: {
        comments: {
          orderBy: { createdAt: 'asc' },
          select: commentDetailSelect,
        },
      },
    });
    if (!review) throw throwNotFoundError(`No review with id ${input.id}`);

    return review.comments;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getReviewCommentsCountHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    const review = await getReviewById({
      ...input,
      select: {
        _count: { select: { comments: true } },
      },
    });
    if (!review) throw throwNotFoundError(`No review with id ${input.id}`);

    return review._count.comments;
  } catch (error) {
    throw throwDbError(error);
  }
};
