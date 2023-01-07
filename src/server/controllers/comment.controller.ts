import { TRPCError } from '@trpc/server';
import { Context } from '~/server/createContext';
import { GetByIdInput } from '~/server/schema/base.schema';
import {
  CommentUpsertInput,
  GetAllCommentsSchema,
  GetCommentReactionsSchema,
} from '~/server/schema/comment.schema';
import { ToggleReacionInput } from '~/server/schema/review.schema';
import { commentDetailSelect, getAllCommentsSelect } from '~/server/selectors/comment.selector';
import {
  createOrUpdateComment,
  deleteCommentById,
  getCommentById,
  getCommentReactions,
  getComments,
  getUserReactionByCommentId,
  updateCommentById,
} from '~/server/services/comment.service';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';

export const getCommentsInfiniteHandler = async ({
  input,
  ctx,
}: {
  input: GetAllCommentsSchema;
  ctx: Context;
}) => {
  input.limit = input.limit ?? 20;
  const limit = input.limit + 1;

  const comments = await getComments({
    input: { ...input, limit },
    user: ctx.user,
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
  ctx: DeepNonNullable<Context> & { ownerId: number };
  input: CommentUpsertInput;
}) => {
  try {
    const { ownerId } = ctx;
    const comment = await createOrUpdateComment({ ...input, ownerId });

    return comment;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const deleteUserCommentHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: GetByIdInput;
}) => {
  try {
    const deleted = await deleteCommentById({ ...input });
    if (!deleted) {
      throw throwNotFoundError(`No comment with id ${input.id}`);
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
    else throwDbError(error);
  }
};

export const getCommentHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    const comment = await getCommentById({
      ...input,
      select: {
        ...commentDetailSelect,
        comments: {
          select: commentDetailSelect,
        },
      },
    });
    if (!comment) throw throwNotFoundError(`No comment with id ${input.id}`);

    return comment;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getCommentCommentsHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    const comment = await getCommentById({
      ...input,
      select: {
        comments: {
          orderBy: { createdAt: 'asc' },
          select: commentDetailSelect,
        },
      },
    });
    if (!comment) throw throwNotFoundError(`No comment with id ${input.id}`);

    return comment.comments;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getCommentCommentsCountHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    const comment = await getCommentById({
      ...input,
      select: {
        _count: { select: { comments: true } },
      },
    });
    if (!comment) throw throwNotFoundError(`No comment with id ${input.id}`);

    return comment._count.comments;
  } catch (error) {
    throw throwDbError(error);
  }
};
