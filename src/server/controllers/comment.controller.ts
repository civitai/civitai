import { ReportReason, ReportStatus } from '@prisma/client';
import { TRPCError } from '@trpc/server';

import { Context } from '~/server/createContext';
import { GetByIdInput } from '~/server/schema/base.schema';
import {
  CommentUpsertInput,
  GetAllCommentsSchema,
  GetCommentReactionsSchema,
} from '~/server/schema/comment.schema';
import { ToggleReactionInput } from '~/server/schema/review.schema';
import { commentDetailSelect, getAllCommentsSelect } from '~/server/selectors/comment.selector';
import {
  createOrUpdateComment,
  deleteCommentById,
  getCommentById,
  getCommentReactions,
  getComments,
  getUserReactionByCommentId,
  updateCommentById,
  updateCommentReportStatusByReason,
} from '~/server/services/comment.service';
import { createNotification } from '~/server/services/notification.service';
import {
  throwAuthorizationError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { DEFAULT_PAGE_SIZE } from '~/server/utils/pagination-helpers';

export const getCommentsInfiniteHandler = async ({
  input,
  ctx,
}: {
  input: GetAllCommentsSchema;
  ctx: Context;
}) => {
  input.limit = input.limit ?? DEFAULT_PAGE_SIZE;
  const limit = input.limit + 1;
  const { user } = ctx;
  const comments = await getComments({
    input: { ...input, limit },
    user,
    select: getAllCommentsSelect,
  });

  let nextCursor: number | undefined;
  if (comments.length > input.limit) {
    const nextItem = comments.pop();
    nextCursor = nextItem?.id;
  }

  return {
    nextCursor,
    comments,
  };
};

export const getCommentReactionsHandler = async ({
  input,
}: {
  input: GetCommentReactionsSchema;
}) => {
  try {
    const reactions = await getCommentReactions(input);

    return reactions;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const upsertCommentHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context> & { ownerId: number; locked: boolean };
  input: CommentUpsertInput;
}) => {
  try {
    const { ownerId, locked } = ctx;
    const comment = await createOrUpdateComment({ ...input, ownerId, locked });

    return comment;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const deleteUserCommentHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    await deleteCommentById({ ...input });
    // if (!deleted) throw throwNotFoundError(`No comment with id ${input.id}`);

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

  const commentReaction = await getUserReactionByCommentId({
    reaction,
    commentId: id,
    userId: user.id,
  });

  try {
    const comment = await updateCommentById({
      id,
      data: {
        reactions: {
          create: commentReaction ? undefined : { reaction, userId: user.id },
          deleteMany: commentReaction ? { reaction, userId: user.id } : undefined,
        },
      },
    });

    if (!comment) {
      throw throwNotFoundError(`No comment with id ${id}`);
    }

    return comment;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const getCommentHandler = async ({ input, ctx }: { input: GetByIdInput; ctx: Context }) => {
  try {
    const comment = await getCommentById({
      ...input,
      select: {
        ...commentDetailSelect,
        comments: {
          select: commentDetailSelect,
        },
      },
      user: ctx.user,
    });
    if (!comment) throw throwNotFoundError(`No comment with id ${input.id}`);

    return comment;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const getCommentCommentsHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: Context;
}) => {
  try {
    const comment = await getCommentById({
      ...input,
      select: {
        comments: {
          orderBy: { createdAt: 'asc' },
          select: commentDetailSelect,
        },
      },
      user: ctx.user,
    });
    if (!comment) throw throwNotFoundError(`No comment with id ${input.id}`);

    return comment.comments;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getCommentCommentsCountHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: Context;
}) => {
  try {
    const comment = await getCommentById({
      ...input,
      select: {
        _count: { select: { comments: true } },
      },
      user: ctx.user,
    });
    if (!comment) throw throwNotFoundError(`No comment with id ${input.id}`);

    return comment._count.comments;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const toggleLockHandler = async ({ input }: { input: GetByIdInput }) => {
  const { id } = input;

  try {
    const comment = await getCommentById({ id, select: { id: true, locked: true } });
    if (!comment) throw throwNotFoundError(`No comment with id ${id}`);

    // Lock comment and its children
    const updatedComment = await updateCommentById({
      id: comment.id,
      data: {
        locked: !comment.locked,
        comments: {
          updateMany: { where: { parentId: comment.id }, data: { locked: !comment.locked } },
        },
      },
    });

    return updatedComment;
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

    const updatedComment = await updateCommentById({ id, data: { tosViolation: true } });
    if (!updatedComment) throw throwNotFoundError(`No comment with id ${id}`);

    await updateCommentReportStatusByReason({
      id: updatedComment.id,
      reason: ReportReason.TOSViolation,
      status: ReportStatus.Actioned,
    });

    // Create notifications in the background
    createNotification({
      userId: updatedComment.user.id,
      type: 'tos-violation',
      details: { modelName: updatedComment.model.name, entity: 'comment' },
    }).catch((error) => {
      // Print out any errors
      // TODO.logs: sent to logger service
      console.error(error);
    });

    return updatedComment;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};
