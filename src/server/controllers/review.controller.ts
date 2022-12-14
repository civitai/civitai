import { reviewDetailSelect } from './../selectors/review.selector';
import { TRPCError } from '@trpc/server';
import { Context } from '~/server/createContext';
import { GetByIdInput, ReportInput } from '~/server/schema/base.schema';
import {
  GetAllReviewsInput,
  GetReviewReactionsInput,
  ReviewUpsertInput,
  ToggleReacionInput,
} from '~/server/schema/review.schema';
import { getAllReviewsSelect, getReactionsSelect } from '~/server/selectors/review.selector';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import {
  getReviewReactions,
  getReviews,
  createOrUpdateReview,
  reportReviewById,
  deleteUserReviewById,
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
    throwDbError(error);
  }
};

export const reportReviewHandler = async ({
  input,
  ctx,
}: {
  input: ReportInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    await reportReviewById({ ...input, userId: ctx.user.id });
  } catch (error) {
    throwDbError(error);
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
    const deleted = await deleteUserReviewById({ ...input, userId: ctx.user.id });

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

export type ReviewDetails = AsyncReturnType<typeof getReviewDetails>;
export const getReviewDetails = async ({ input: { id } }: { input: GetByIdInput }) => {
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

export const getReviewComments = async ({ input }: { input: GetByIdInput }) => {
  try {
    const review = await getReviewById({
      ...input,
      select: {
        comments: {
          select: {
            id: true,
            content: true,
            createdAt: true,
            reactions: { select: getReactionsSelect },
            user: { select: simpleUserSelect },
          },
        },
      },
    });

    if (!review) throw throwNotFoundError(`No review with id ${input.id}`);

    return review;
  } catch (error) {
    throw throwDbError(error);
  }
};
