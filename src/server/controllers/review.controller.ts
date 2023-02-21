import { ReportReason, ReportStatus } from '@prisma/client';
import { TRPCError } from '@trpc/server';

import { env } from '~/env/server.mjs';
import { Context } from '~/server/createContext';
import { GetByIdInput } from '~/server/schema/base.schema';
import {
  GetAllReviewsInput,
  GetReviewReactionsInput,
  ReviewUpsertInput,
  ToggleReactionInput,
} from '~/server/schema/review.schema';
import { commentDetailSelect } from '~/server/selectors/comment.selector';
import { getAllReviewsSelect, reviewDetailSelect } from '~/server/selectors/review.selector';
import { createNotification } from '~/server/services/notification.service';
import {
  getReviewReactions,
  getReviews,
  createOrUpdateReview,
  deleteReviewById,
  getUserReactionByReviewId,
  updateReviewById,
  getReviewById,
  convertReviewToComment,
  updateReviewReportStatusByReason,
} from '~/server/services/review.service';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
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
  const canViewNsfw = ctx.user?.showNsfw ?? env.UNAUTHENTICATED_LIST_NSFW;
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
              .map((x) => ({ ...x.image, tags: x.image.tags.map(({ tag }) => tag) }))
          : imagesOnReviews.map((x) => ({ ...x.image, tags: x.image.tags.map(({ tag }) => tag) }));
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
    const canViewNsfw = ctx.user?.showNsfw ?? env.UNAUTHENTICATED_LIST_NSFW;
    const prioritizeSafeImages = !ctx.user || (ctx.user?.showNsfw && ctx.user?.blurNsfw);
    const result = await getReviewById({
      id,
      select: reviewDetailSelect(canViewNsfw),
      user: ctx.user,
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
              .map((x) => ({ ...x.image, tags: x.image.tags.map(({ tag }) => tag) }))
          : imagesOnReviews.map((x) => ({ ...x.image, tags: x.image.tags.map(({ tag }) => tag) })),
    };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const getReviewCommentsHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: Context;
}) => {
  try {
    const review = await getReviewById({
      ...input,
      select: {
        comments: {
          orderBy: { createdAt: 'asc' },
          select: commentDetailSelect,
        },
      },
      user: ctx.user,
    });
    if (!review) throw throwNotFoundError(`No review with id ${input.id}`);

    return review.comments;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getReviewCommentsCountHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: Context;
}) => {
  try {
    const review = await getReviewById({
      ...input,
      select: {
        _count: { select: { comments: true } },
      },
      user: ctx.user,
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

export const setTosViolationHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { user } = ctx;
    const { id } = input;
    if (!user.isModerator) throw throwAuthorizationError('Only moderators can set TOS violation');

    const updatedReview = await updateReviewById({ id, data: { tosViolation: true } });
    if (!updatedReview) throw throwNotFoundError(`No review with id ${id}`);

    await updateReviewReportStatusByReason({
      id: updatedReview.id,
      reason: ReportReason.TOSViolation,
      status: ReportStatus.Actioned,
    });

    // Create notifications in the background
    createNotification({
      userId: updatedReview.user.id,
      type: 'tos-violation',
      details: { modelName: updatedReview.model.name, entity: 'review' },
    }).catch((error) => {
      // Print out any errors
      // TODO.logs: sent to logger service
      console.error(error);
    });

    return updatedReview;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};
