import { GetByIdInput } from './../schema/base.schema';
import {
  upsertComment,
  getComments,
  deleteComment,
  getCommentCount,
  getCommentsThreadDetails,
  toggleLockCommentsThread,
  getComment,
  toggleHideComment,
} from './../services/commentsv2.service';
import {
  UpsertCommentV2Input,
  GetCommentsV2Input,
  CommentConnectorInput,
} from './../schema/commentv2.schema';
import { Context } from '~/server/createContext';
import {
  handleLogError,
  throwAuthorizationError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { commentV2Select } from '~/server/selectors/commentv2.selector';
import { TRPCError } from '@trpc/server';
import { dbRead } from '../db/client';
import { ToggleHideCommentInput } from '~/server/schema/commentv2.schema';
import { hasEntityAccess } from '../services/common.service';
import { HiddenUsers } from '~/server/services/user-preferences.service';

export type InfiniteCommentResults = AsyncReturnType<typeof getInfiniteCommentsV2Handler>;
export type InfiniteCommentV2Model = InfiniteCommentResults['comments'][0];
export const getInfiniteCommentsV2Handler = async ({
  ctx,
  input,
}: {
  ctx: Context;
  input: GetCommentsV2Input;
}) => {
  try {
    const limit = input.limit + 1;

    const excludedUserIds = (await HiddenUsers.getCached({ userId: ctx.user?.id })).map(
      (x) => x.id
    );
    const comments = await getComments({
      ...input,
      excludedUserIds,
      limit,
      select: commentV2Select,
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
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getCommentHandler = async ({ ctx, input }: { ctx: Context; input: GetByIdInput }) => {
  try {
    return await getComment({ ...input });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const upsertCommentV2Handler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: UpsertCommentV2Input;
}) => {
  try {
    const type =
      input.entityType === 'image'
        ? 'Image'
        : input.entityType === 'post'
        ? 'Post'
        : input.entityType === 'article'
        ? 'Article'
        : input.entityType === 'comment'
        ? 'Comment'
        : input.entityType === 'review'
        ? 'Review'
        : input.entityType === 'bounty'
        ? 'Bounty'
        : input.entityType === 'bountyEntry'
        ? 'BountyEntry'
        : input.entityType === 'clubPost'
        ? 'ClubPost'
        : null;

    if (type === 'Post' || type === 'Article') {
      // Only cgheck access if model has 1 version. Otherwise, we can't be sure that the user has access to the latest version.
      const [access] = await hasEntityAccess({
        entityType: type,
        entityIds: [input.entityId],
        userId: ctx.user.id,
        isModerator: ctx.user.isModerator,
      });

      if (!access?.hasAccess) {
        throw throwAuthorizationError('You do not have access to this resource.');
      }
    }

    if (type === 'ClubPost') {
      // confirm the user has access to this clubPost:
      const clubPost = await dbRead.clubPost.findFirst({
        where: { id: input.entityId },
        select: { membersOnly: true, clubId: true },
      });

      if (!clubPost) throw throwNotFoundError(`No clubPost with id ${input.entityId}`);

      if (clubPost.membersOnly) {
        // confirm the user is a member of this club in any way:
        const club = await dbRead.club.findFirst({
          where: { id: clubPost.clubId },
          select: {
            memberships: { where: { userId: ctx.user.id } },
            userId: true,
            admins: { where: { userId: ctx.user.id } },
          },
        });

        if (!club?.admins.length && !club?.memberships.length && club?.userId !== ctx.user.id)
          throw throwAuthorizationError('You do not have access to this club post.');
      }
    }

    const result = await upsertComment({ ...input, userId: ctx.user.id });
    if (!input.id) {
      if (type && type !== 'ClubPost' && type !== 'Article') {
        await ctx.track.comment({
          type,
          nsfw: result.nsfw,
          entityId: result.id,
        });
      }
    }

    return result;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const deleteCommentV2Handler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: GetByIdInput;
}) => {
  try {
    const deleted = await deleteComment(input);
    if (!deleted) throw throwNotFoundError(`No comment with id ${input.id}`);

    ctx.track.commentEvent({ type: 'Delete', commentId: deleted.id }).catch(handleLogError);

    return deleted;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const getCommentCountV2Handler = async ({
  ctx,
  input,
}: {
  ctx: Context;
  input: CommentConnectorInput;
}) => {
  try {
    return await getCommentCount(input);
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getCommentsThreadDetailsHandler = async ({
  ctx,
  input,
}: {
  ctx: Context;
  input: CommentConnectorInput;
}) => {
  try {
    return await getCommentsThreadDetails(input);
  } catch (error) {
    throw throwDbError(error);
  }
};

export const toggleLockThreadDetailsHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: CommentConnectorInput;
}) => {
  try {
    await toggleLockCommentsThread(input);
  } catch (error) {
    throw throwDbError(error);
  }
};

export const toggleHideCommentHandler = async ({
  input,
  ctx,
}: {
  input: ToggleHideCommentInput;
  ctx: DeepNonNullable<Context>;
}) => {
  const { id: userId, isModerator } = ctx.user;
  const { id, entityType } = input;

  try {
    const comment = await dbRead.commentV2.findFirst({
      where: { id },
      select: {
        hidden: true,
        userId: true,
        thread: { select: { [entityType]: { select: { userId: true } } } },
      },
    });
    if (!comment) throw throwNotFoundError(`No comment with id ${input.id}`);
    if (
      !isModerator &&
      // Nasty hack to get around the fact that the thread is not typed
      (comment.thread[entityType] as any)?.userId !== userId
    )
      throw throwAuthorizationError();

    const updatedComment = await toggleHideComment({
      id: input.id,
      currentToggle: comment.hidden ?? false,
    });

    return updatedComment;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};
