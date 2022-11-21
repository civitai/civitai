import { Context } from '~/server/createContext';
import { GetByIdInput, ReportInput } from '~/server/schema/base.schema';
import {
  GetAllReviewsInput,
  GetReviewReactionsInput,
  ReviewUpsertInput,
  ToggleReacionInput,
} from '~/server/schema/review.schema';
import { getAllReviewsSelect } from '~/server/selectors/review.selector';
import {
  getReviewReactions,
  getReviews,
  createOrUpdateReview,
  reportReviewById,
  deleteUserReviewById,
  getUserReactionByReviewId,
  updateReviewById,
} from '~/server/services/review.service';
import { handleDbError } from '~/server/utils/errorHandling';

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
    handleDbError({ code: 'INTERNAL_SERVER_ERROR', error: error });
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
    handleDbError({ code: 'INTERNAL_SERVER_ERROR', error });
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
    handleDbError({
      code: 'INTERNAL_SERVER_ERROR',
      error,
    });
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
      throw handleDbError({
        code: 'NOT_FOUND',
        message: `No review with id ${input.id}`,
      });
    }

    return deleted;
  } catch (error) {
    handleDbError({ code: 'INTERNAL_SERVER_ERROR', error });
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
      throw handleDbError({ code: 'NOT_FOUND', message: `No review with id ${id}` });
    }

    return review;
  } catch (error) {
    handleDbError({ code: 'INTERNAL_SERVER_ERROR', error });
  }
};
