import { TRPCError } from '@trpc/server';
import type { Context, ProtectedContext } from '~/server/createContext';
import type {
  ToggleHideCommentInput,
  GetCommentsInfiniteInput,
} from '~/server/schema/commentv2.schema';
import { BlockedByUsers, BlockedUsers } from '~/server/services/user-preferences.service';
import { getContentOwnerIdForComment } from '~/server/services/block-check.service';
import { bulkSetCommentV2TosViolation } from '~/server/services/commentsv2.service';
import { assertCrucibleVisible } from '~/server/services/crucible.service';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { assertStorylineVisible } from '~/server/services/storyline.service';
import { amIBlockedByUser } from '~/server/services/user.service';
import { assertBountyVisible } from '~/server/services/bounty-visibility';
import {
  handleLogError,
  throwAuthorizationError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { storylineReaderLevel } from '~/server/utils/storyline-reader-level';
import { updateEntityMetric } from '~/server/utils/metric-helpers';
import { hasEntityAccess } from '../services/common.service';
import type { GetByIdInput } from './../schema/base.schema';
import type {
  CommentConnectorInput,
  SectionMuteInput,
  ToggleThreadMuteInput,
  UpsertCommentV2Input,
} from './../schema/commentv2.schema';
import {
  deleteComment,
  getComment,
  getSectionMuted,
  getThreadMuted,
  toggleSectionMute,
  toggleThreadMute,
  getCommentCount,
  getCommentsThreadDetails2,
  getCommentsInfinite,
  getCommentThreadBounty,
  isCommentDetached,
  isCommentGoneForMembers,
  isThreadDetached,
  getCommentCrucibleId,
  getCommentStorylineId,
  getCommentThreadStorylineId,
  toggleHideComment,
  toggleLockCommentsThread,
  togglePinComment,
  upsertComment,
} from './../services/commentsv2.service';
import { getCommentExcludedUserIds } from '~/server/services/comment-exclusions.service';

/** Creators who blocked the viewer and creators the viewer blocked. */
async function getBlockedCreatorIds(userId: number) {
  const [blockedBy, blocked] = await Promise.all([
    BlockedByUsers.getCached({ userId }),
    BlockedUsers.getCached({ userId }),
  ]);
  return [...new Set([...blockedBy, ...blocked].map((x) => x.id))];
}

type CommentReadContext = Pick<Context, 'user' | 'features' | 'req'>;

/** The storyline page's own gate, so a thread is never readable where its storyline is not. */
async function assertStorylineThreadVisible(storylineId: number, ctx: CommentReadContext) {
  if (!getFeatureFlags(ctx).storylines) throw throwNotFoundError('Storyline not found');
  return assertStorylineVisible(storylineId, ctx.user, storylineReaderLevel(ctx, undefined));
}

/**
 * Returns the storyline when the thread is one. A reply is addressed as entity `comment`, so its
 * storyline is found through the parent comment's thread.
 */
export async function assertCommentEntityVisible(
  input: { entityType: string; entityId: number },
  ctx: CommentReadContext
) {
  const { user } = ctx;
  if (input.entityType === 'storyline') return assertStorylineThreadVisible(input.entityId, ctx);
  let crucibleId = input.entityType === 'crucible' ? input.entityId : null;
  if (input.entityType === 'comment') {
    const [detached, storylineId, replyCrucibleId] = await Promise.all([
      !user?.isModerator && isCommentDetached(input.entityId),
      getCommentStorylineId(input.entityId),
      user?.isModerator ? null : getCommentCrucibleId(input.entityId),
    ]);
    if (detached) throw throwNotFoundError();
    if (storylineId) return assertStorylineThreadVisible(storylineId, ctx);
    crucibleId = replyCrucibleId;
  }
  if (input.entityType === 'bounty') await assertBountyVisible({ bountyId: input.entityId }, user);
  else if (input.entityType === 'bountyEntry')
    await assertBountyVisible({ entryId: input.entityId }, user);
  else if (crucibleId)
    await assertCrucibleVisible(crucibleId, {
      viewerId: user?.id,
      isModerator: !!user?.isModerator,
      isGreen: !!ctx.features?.isGreen,
      blockedCreatorIds: user && !user.isModerator ? await getBlockedCreatorIds(user.id) : [],
    });
}

/**
 * For a member's action on one comment: a comment they cannot see answers as gone, and the storyline
 * or crucible above it gates it as it gates a reply there.
 */
export async function assertCommentActionable(commentId: number, ctx: CommentReadContext) {
  const { user } = ctx;
  if (user?.isModerator) return;
  const [gone, storylineId, crucibleId] = await Promise.all([
    isCommentGoneForMembers(commentId),
    getCommentStorylineId(commentId),
    getCommentCrucibleId(commentId),
  ]);
  if (gone) throw throwNotFoundError(`No comment with id ${commentId}`);
  if (storylineId) {
    const storyline = await assertStorylineThreadVisible(storylineId, ctx);
    if (storyline.tosViolation)
      throw throwAuthorizationError('This storyline has been taken down.');
    return;
  }
  if (!crucibleId) return;
  await assertCrucibleVisible(crucibleId, {
    viewerId: user?.id,
    isModerator: false,
    isGreen: !!ctx.features?.isGreen,
    blockedCreatorIds: user ? await getBlockedCreatorIds(user.id) : [],
  });
}

export const getCommentHandler = async ({ ctx, input }: { ctx: Context; input: GetByIdInput }) => {
  try {
    const comment = await getComment({ ...input, isModerator: ctx.user?.isModerator ?? false });
    if (!comment) throw throwNotFoundError(`No comment with id ${input.id}`);

    if (!ctx.user?.isModerator) {
      const [detached, bounty, crucibleId, storylineId] = await Promise.all([
        isThreadDetached(comment.threadId),
        getCommentThreadBounty(comment.threadId),
        getCommentCrucibleId(comment.id),
        getCommentThreadStorylineId(comment.threadId),
      ]);
      if (detached) throw throwNotFoundError(`No comment with id ${input.id}`);
      if (bounty) await assertBountyVisible(bounty, ctx.user);
      if (crucibleId)
        await assertCommentEntityVisible({ entityType: 'crucible', entityId: crucibleId }, ctx);
      if (storylineId)
        await assertCommentEntityVisible({ entityType: 'storyline', entityId: storylineId }, ctx);
    }

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
    if (!ctx.user.isModerator) {
      // Editing, or replying to, a comment a member cannot see answers as if it were gone.
      const gone = [input.id, input.entityType === 'comment' ? input.entityId : undefined];
      for (const id of gone)
        if (id && (await isCommentGoneForMembers(id)))
          throw throwNotFoundError(`No comment with id ${id}`);
    }
    const target = await assertCommentEntityVisible(input, ctx);
    // An edit is also gated by the stored comment's own thread: `entityType` is client-supplied.
    const storyline = input.id
      ? await assertCommentEntityVisible({ entityType: 'comment', entityId: input.id }, ctx)
      : target;
    if (storyline && storyline.tosViolation && !ctx.user.isModerator)
      throw throwAuthorizationError('This storyline has been taken down.');
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

    const result = await upsertComment({
      ...input,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
      track: ctx.track,
    });
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
    // A detached or hidden comment is kept content: only a moderator removes it.
    if (!ctx.user.isModerator && (await isCommentGoneForMembers(input.id)))
      throw throwNotFoundError(`No comment with id ${input.id}`);
    const deleted = await deleteComment({ ...input, byAuthor: !ctx.user.isModerator });
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
    await assertCommentEntityVisible(input, ctx);
    return await getCommentCount({ ...input, isModerator: ctx.user?.isModerator ?? false });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getCommentsThreadDetailsHandler = async ({
  input,
  ctx,
}: {
  input: CommentConnectorInput;
  ctx: Context;
}) => {
  try {
    await assertCommentEntityVisible(input, ctx);
    return await getCommentsThreadDetails2(input);
  } catch (error) {
    throw throwDbError(error);
  }
};

export const toggleSectionMuteHandler = async ({
  ctx,
  input,
}: {
  ctx: ProtectedContext;
  input: SectionMuteInput;
}) => {
  try {
    if (input.entityType === 'storyline') await assertCommentEntityVisible(input, ctx);
    return await toggleSectionMute({ ...input, userId: ctx.user.id });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const getSectionMutedHandler = async ({
  ctx,
  input,
}: {
  ctx: ProtectedContext;
  input: SectionMuteInput;
}) => {
  try {
    if (input.entityType === 'storyline') await assertCommentEntityVisible(input, ctx);
    return await getSectionMuted({ ...input, userId: ctx.user.id });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const toggleThreadMuteHandler = async ({
  ctx,
  input,
}: {
  ctx: ProtectedContext;
  input: ToggleThreadMuteInput;
}) => {
  try {
    if (!ctx.user.isModerator && (await isCommentDetached(input.commentId)))
      throw throwNotFoundError();
    return await toggleThreadMute({ ...input, userId: ctx.user.id });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const getThreadMutedHandler = async ({
  ctx,
  input,
}: {
  ctx: ProtectedContext;
  input: ToggleThreadMuteInput;
}) => {
  try {
    return await getThreadMuted({ ...input, userId: ctx.user.id });
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
  const { id } = input;

  try {
    await assertCommentActionable(id, ctx);
    const { hidden, ownerId } = await getContentOwnerIdForComment(id);
    if (!isModerator && ownerId !== userId) throw throwAuthorizationError();

    const updatedComment = await toggleHideComment({ id, currentToggle: hidden });

    return updatedComment;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const togglePinnedCommentHandler = async ({
  input,
  ctx,
}: {
  input: ToggleHideCommentInput;
  ctx: ProtectedContext;
}) => {
  const { id: userId, isModerator } = ctx.user;
  const { id } = input;

  try {
    await assertCommentActionable(id, ctx);
    const { ownerId } = await getContentOwnerIdForComment(id);
    if (!isModerator && ownerId !== userId) throw throwAuthorizationError();

    return await togglePinComment({ id });
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
    await assertCommentEntityVisible(input, ctx);
    const excludedUserIds = await getCommentExcludedUserIds({
      entityType: input.entityType,
      entityId: input.entityId,
      userId: ctx.user?.id,
    });

    return await getCommentsInfinite({
      ...input,
      excludedUserIds,
      isModerator: ctx.user?.isModerator ?? false,
    });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const setTosViolationHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: ProtectedContext;
}) => {
  try {
    // The service is the bulk one the moderator app already calls, so this path picks up the
    // report actioning, reporter rewards and owner notification rather than re-deriving them.
    const result = await bulkSetCommentV2TosViolation({
      ids: [input.id],
      actor: { id: ctx.user.id, ip: ctx.ip },
    });
    if (!result.count) throw throwNotFoundError(`No comment with id ${input.id}`);

    return result;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};
