import { ModelStatus, Prisma, ReportReason, ReportStatus } from '@prisma/client';
import { TRPCError } from '@trpc/server';

import { Context } from '~/server/createContext';
import { GetByIdInput } from '~/server/schema/base.schema';
import {
  CommentUpsertInput,
  GetAllCommentsSchema,
  GetCommentReactionsSchema,
} from '~/server/schema/comment.schema';
import { commentDetailSelect, getAllCommentsSelect } from '~/server/selectors/comment.selector';
import {
  createOrUpdateComment,
  deleteCommentById,
  getCommentById,
  getCommentReactions,
  getComments,
  toggleHideComment,
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
import { dbRead } from '../db/client';
import { hasEntityAccess } from '../services/common.service';

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

  const commentIds = comments.map((c) => c.id);
  if (commentIds.length === 0) return { comments: [], nextCursor: undefined };

  const counts = await dbRead.$queryRaw<{ id: number; count: number }[]>`
    SELECT
      c."parentId" as id,
      COUNT(c.id) as count
    FROM "Comment" c
    WHERE c."parentId" IN (${Prisma.join(commentIds)})
    GROUP BY c."parentId"
  `;
  const countsMap = Object.fromEntries(counts.map((c) => [c.id, Number(c.count)]));

  let nextCursor: number | undefined;
  if (comments.length > input.limit) {
    const nextItem = comments.pop();
    nextCursor = nextItem?.id;
  }

  return {
    nextCursor,
    comments: comments.map((c) => ({
      ...c,
      _count: { comments: countsMap[c.id] ?? 0 },
    })),
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
    const { modelId } = input;

    // Get model and at least 2 version to confirm access.
    // If model has 1 version, check access to that version. Otherwise, ignore.
    const model = await dbRead.model.findUnique({
      where: { id: modelId },
      select: {
        id: true,
        modelVersions: {
          take: 2,
          select: { id: true },
          where: { status: ModelStatus.Published },
          orderBy: { index: 'asc' },
        },
      },
    });

    const [version] = model?.modelVersions ?? [];

    if (!version) {
      throw throwNotFoundError(`This model has no versions.`);
    }
    if (model?.modelVersions.length === 1) {
      // Only cgheck access if model has 1 version. Otherwise, we can't be sure that the user has access to the latest version.
      const [access] = await hasEntityAccess({
        entityType: 'ModelVersion',
        entityIds: [version.id],
        userId: ctx.user.id,
        isModerator: ctx.user.isModerator,
      });

      if (!access?.hasAccess) {
        throw throwAuthorizationError("You do not have access to this model's latest version.");
      }
    }

    const comment = await createOrUpdateComment({ ...input, ownerId, locked });

    if (!input.commentId) {
      await ctx.track.comment({
        type: 'Model',
        entityId: comment.modelId,
        nsfw: comment.nsfw,
      });
      await ctx.track.commentEvent({ type: 'Create', commentId: comment.id });

      return comment;
    } else {
      await ctx.track.commentEvent({ type: 'Update', commentId: comment.id });

      // Explicitly check for boolean value to track hide/unhide events
      if (input.hidden === true)
        await ctx.track.commentEvent({ type: 'Hide', commentId: comment.id });
      else if (input.hidden === false)
        await ctx.track.commentEvent({ type: 'Unhide', commentId: comment.id });
    }
  } catch (error) {
    throw throwDbError(error);
  }
};

export const toggleHideCommentHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    await toggleHideComment({
      ...input,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator ?? false,
    });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const deleteUserCommentHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const deleted = await deleteCommentById({ ...input });
    // if (!deleted) throw throwNotFoundError(`No comment with id ${input.id}`);

    await ctx.track.commentEvent({ type: 'Delete', commentId: deleted.id });

    // return deleted;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
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
      category: 'System',
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
