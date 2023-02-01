import { GetByIdInput } from './../schema/base.schema';
import { TRPCError } from '@trpc/server';

import { Context } from '~/server/createContext';
import {
  GetAllReviewsInput,
  GetReviewReactionsInput,
  ReviewUpsertInput,
  ToggleReactionInput,
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
  convertReviewToComment,
} from '~/server/services/review.service';
import {
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { env } from '~/env/server.mjs';
import { DEFAULT_PAGE_SIZE } from '~/server/utils/pagination-helpers';

export const getReviewsInfiniteHandler = async ({
  input,
  ctx,
}: {
  input: GetAllReviewsInput;
  ctx: Context;
}) => {
  input.limit = input.limit ?? DEFAULT_PAGE_SIZE;
  const limit = input.limit + 1;
  const canViewNsfw = ctx.user?.showNsfw ?? env.UNAUTHENTICATE_LIST_NSFW;
  const prioritizeSafeImages = !ctx.user || (ctx.user?.showNsfw && ctx.user?.blurNsfw);

  const reviews = await getReviews({
    input: { ...input, limit },
    user: ctx.user,
    select: getAllReviewsSelect(canViewNsfw),
  });

  let nextCursor: number | undefined;
  if (reviews.length > input.limit) {
    const nextItem = reviews.pop();
    nextCursor = nextItem?.id;
  }

  return {
    nextCursor,
    reviews: reviews.map(({ imagesOnReviews, ...review }) => {
      const isOwnerOrModerator = review.user.id === ctx.user?.id || ctx.user?.isModerator;
      const images =
        !isOwnerOrModerator && prioritizeSafeImages
          ? imagesOnReviews
              .sort((a, b) => {
                return a.image.nsfw === b.image.nsfw ? 0 : a.image.nsfw ? 1 : -1;
              })
              .map((x) => x.image)
          : imagesOnReviews.map((x) => x.image);
      return { ...review, images };
    }),
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
  ctx: DeepNonNullable<Context> & { ownerId: number; locked: boolean };
  input: ReviewUpsertInput;
}) => {
  try {
    const { ownerId, locked } = ctx;
    const review = await createOrUpdateReview({ ...input, ownerId, locked });

    return review;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const deleteUserReviewHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    await deleteReviewById({ ...input });
    // if (!deleted) throw throwNotFoundError(`No review with id ${input.id}`);

    // return deleted;
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
  input: ToggleReactionInput;
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
    if (!review) throw throwNotFoundError(`No review with id ${id}`);

    return review;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
};

export const toggleExcludeHandler = async ({ input }: { input: GetByIdInput }) => {
  const { id } = input;
  const { exclude } = (await getReviewById({ id, select: { exclude: true } })) ?? {};

  try {
    const review = await updateReviewById({
      id,
      data: {
        exclude: !exclude,
      },
    });
    if (!review) throw throwNotFoundError(`No review with id ${id}`);

    return review;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
};

export type ReviewDetails = AsyncReturnType<typeof getReviewDetailsHandler>;
export const getReviewDetailsHandler = async ({
  input: { id },
  ctx,
}: {
  input: GetByIdInput;
  ctx: Context;
}) => {
  try {
    const canViewNsfw = ctx.user?.showNsfw ?? env.UNAUTHENTICATE_LIST_NSFW;
    const prioritizeSafeImages = !ctx.user || (ctx.user?.showNsfw && ctx.user?.blurNsfw);
    const result = await getReviewById({
      id,
      select: reviewDetailSelect(canViewNsfw),
    });
    if (!result) throw throwNotFoundError(`No review with id ${id}`);

    const { imagesOnReviews, ...review } = result;
    const isOwnerOrModerator = review.user.id === ctx.user?.id || ctx.user?.isModerator;
    return {
      ...review,
      images:
        !isOwnerOrModerator && prioritizeSafeImages
          ? imagesOnReviews
              .sort((a, b) => {
                return a.image.nsfw === b.image.nsfw ? 0 : a.image.nsfw ? 1 : -1;
              })
              .map((x) => x.image)
          : imagesOnReviews.map((x) => x.image),
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

export const convertToCommentHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    const review = await getReviewById({
      ...input,
      select: { id: true, text: true, modelId: true, userId: true, createdAt: true },
    });
    if (!review) throw throwNotFoundError(`No review with id ${input.id}`);
    if (!review.text)
      throw throwBadRequestError(
        `This review can't be converted to comment because it doesn't have any text message`
      );

    // Type casting to prevent type error since we already cover that text property is not null at this point
    const results = await convertReviewToComment(review as DeepNonNullable<typeof review>);

    return results;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const toggleLockHandler = async ({ input }: { input: GetByIdInput }) => {
  const { id } = input;

  try {
    const review = await getReviewById({ id, select: { id: true, locked: true } });
    if (!review) throw throwNotFoundError(`No comment with id ${id}`);

    // Lock review and its children
    const updatedReview = await updateReviewById({
      id: review.id,
      data: {
        locked: !review.locked,
        comments: {
          updateMany: { where: { reviewId: review.id }, data: { locked: !review.locked } },
        },
      },
    });

    return updatedReview;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};
