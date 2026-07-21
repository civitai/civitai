import { TRPCError } from '@trpc/server';
import type { Context, ProtectedContext } from '~/server/createContext';
import type {
  ToggleHideCommentInput,
  GetCommentsInfiniteInput,
} from '~/server/schema/commentv2.schema';
import {
  BlockedByUsers,
  BlockedUsers,
  HiddenUsers,
} from '~/server/services/user-preferences.service';
import { amIBlockedByUser } from '~/server/services/user.service';
import {
  handleLogError,
  throwAuthorizationError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { boundExcludedUserIds } from '~/server/utils/excluded-user-ids';
import { updateEntityMetric } from '~/server/utils/metric-helpers';
import { dbRead } from '../db/client';
import { hasEntityAccess } from '../services/common.service';
import type { GetByIdInput } from './../schema/base.schema';
import type { CommentConnectorInput, UpsertCommentV2Input } from './../schema/commentv2.schema';
import {
  deleteComment,
  getComment,
  getCommentCount,
  getCommentsThreadDetails2,
  getCommentsInfinite,
  isViewerContentOwner,
  toggleHideComment,
  toggleLockCommentsThread,
  upsertComment,
} from './../services/commentsv2.service';

export const getCommentHandler = async ({ ctx, input }: { ctx: Context; input: GetByIdInput }) => {
  try {
    const comment = await getComment({ ...input });
    if (!comment) throw throwNotFoundError(`No comment with id ${input.id}`);

    if (ctx.user && !ctx.user.isModerator) {
      const blocked = await amIBlockedByUser({
        userId: ctx.user.id,
        targetUserId: comment.user.id,
      });
      if (blocked) throw throwNotFoundError();
    }

    return comment;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const upsertCommentV2Handler = async ({
  ctx,
  input,
}: {
  ctx: ProtectedContext;
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
        : input.entityType === 'challenge'
        ? 'Challenge'
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

    const result = await upsertComment({ ...input, userId: ctx.user.id });
    if (!input.id) {
      if (type && type !== 'Article' && type !== 'Challenge') {
        await ctx.track.comment({
          type,
          nsfw: result.nsfw,
          entityId: result.id,
        });
      }

      if (type === 'Image') {
        await updateEntityMetric({
          ctx,
          entityType: 'Image',
          entityId: input.entityId,
          metricType: 'Comment',
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
  ctx: ProtectedContext;
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
    // Fetch thread metadata including hiddenCount (needs excludedUserIds for accurate count)
    const hiddenUsers = (await HiddenUsers.getCached({ userId: ctx.user?.id })).map((x) => x.id);
    const blockedByUsers = (await BlockedByUsers.getCached({ userId: ctx.user?.id })).map(
      (x) => x.id
    );
    const blockedUsers = (await BlockedUsers.getCached({ userId: ctx.user?.id })).map((x) => x.id);
    // On the owner's own content, don't hide a blocker's engagement from them (they must still
    // be able to see + report it) — drop blockedByUsers only in that case; keep the anti-
    // harassment exclusion for every non-owner viewer.
    const isContentOwner = await isViewerContentOwner({
      entityType: input.entityType,
      entityId: input.entityId,
      userId: ctx.user?.id,
      blockedByUsers,
    });
    // De-dupe + cap so the downstream `notIn` / raw `NOT IN` stays under the Postgres
    // bind-param limit (heavily-blocked viewer otherwise → P2029 → 500). Ordering is a
    // load-bearing safety priority — see boundExcludedUserIds.
    const excludedUserIds = boundExcludedUserIds(hiddenUsers, blockedByUsers, blockedUsers, {
      isContentOwner,
    });

    return await getCommentsThreadDetails2({ ...input, excludedUserIds });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const toggleLockThreadDetailsHandler = async ({
  ctx,
  input,
}: {
  ctx: ProtectedContext;
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
  ctx: ProtectedContext;
}) => {
  const { id: userId, isModerator } = ctx.user;
  const { id, entityType } = input;

  try {
    const ownerField = entityType === 'challenge' ? 'createdById' : 'userId';
    // Comic chapter threads use comicProject relation instead of a direct entity relation
    const threadSelect =
      entityType === 'comicChapter'
        ? { comicChapter: { select: { project: { select: { userId: true } } } } }
        : { [entityType]: { select: { [ownerField]: true } } };
    const comment = await dbRead.commentV2.findFirst({
      where: { id },
      select: {
        hidden: true,
        userId: true,
        thread: { select: threadSelect },
      },
    });
    if (!comment) throw throwNotFoundError(`No comment with id ${input.id}`);
    const threadData = comment.thread as any;
    const entityOwner =
      entityType === 'comicChapter'
        ? threadData.comicChapter?.project?.userId
        : threadData[entityType]?.[ownerField];
    if (
      !isModerator &&
      // Nasty hack to get around the fact that the thread is not typed
      entityOwner !== userId
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

export const getCommentsInfiniteHandler = async ({
  ctx,
  input,
}: {
  ctx: Context;
  input: GetCommentsInfiniteInput;
}) => {
  try {
    const hiddenUsers = (await HiddenUsers.getCached({ userId: ctx.user?.id })).map((x) => x.id);
    const blockedByUsers = (await BlockedByUsers.getCached({ userId: ctx.user?.id })).map(
      (x) => x.id
    );
    const blockedUsers = (await BlockedUsers.getCached({ userId: ctx.user?.id })).map((x) => x.id);
    // On the owner's own content, don't hide a blocker's engagement from them (they must still
    // be able to see + report it) — drop blockedByUsers only in that case; keep the anti-
    // harassment exclusion for every non-owner viewer.
    const isContentOwner = await isViewerContentOwner({
      entityType: input.entityType,
      entityId: input.entityId,
      userId: ctx.user?.id,
      blockedByUsers,
    });
    // De-dupe + cap so the downstream `notIn` / raw `NOT IN` stays under the Postgres
    // bind-param limit (heavily-blocked viewer otherwise → P2029 → 500). Ordering is a
    // load-bearing safety priority — see boundExcludedUserIds.
    const excludedUserIds = boundExcludedUserIds(hiddenUsers, blockedByUsers, blockedUsers, {
      isContentOwner,
    });

    return await getCommentsInfinite({ ...input, excludedUserIds });
  } catch (error) {
    throw throwDbError(error);
  }
};
