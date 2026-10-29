import type { Context } from '~/server/createContext';
import { constants } from '~/server/common/constants';
import { assertCommentEntityVisible } from '~/server/controllers/commentv2.controller';
import { kyselyV3Read } from '~/server/db/kyselyDb';
import type {
  GetCommentRepliesInput,
  GetCommentSectionInput,
  GetCommentThreadInput,
} from '~/server/schema/commentv3.schema';
import type { CommentConnectorInput } from '~/server/schema/commentv2.schema';
import { getCommentExcludedUserIds } from '~/server/services/comment-exclusions.service';
import {
  type CommentV3Page,
  type CommentV3Viewer,
  getCommentEntity,
  getCommentLock,
  getCommentReplies,
  getCommentSection,
  getCommentThread,
} from '~/server/services/commentv3/read.service';
import { getCosmeticsAndProfilePicturesForUsers } from '~/server/services/user.service';
import { throwNotFoundError } from '~/server/utils/errorHandling';

type Entity = { entityType: string; entityId: number };

/** The viewer, with the comment authors they must not see on this entity. */
async function viewerFor(ctx: Context, entity: Entity): Promise<CommentV3Viewer> {
  return {
    userId: ctx.user?.id,
    isModerator: !!ctx.user?.isModerator,
    excludedUserIds: await getCommentExcludedUserIds({
      entityType: entity.entityType as CommentConnectorInput['entityType'],
      entityId: entity.entityId,
      userId: ctx.user?.id,
    }),
  };
}

/** Fills each author's profile picture and cosmetics from the user caches, as the v2 reads do. */
async function withAuthors(page: CommentV3Page) {
  const lookup = await getCosmeticsAndProfilePicturesForUsers(
    page.comments.flatMap((c) => (c.user ? [c.user.id] : []))
  );
  return {
    ...page,
    comments: page.comments.map((c) => ({
      ...c,
      user: c.user ? { ...c.user, ...lookup(c.user.id) } : null,
    })),
  };
}

const replyDepth = (entityType: string) =>
  Math.min(
    constants.comments.getAutoExpandDepth({ entityType }),
    constants.comments.getMaxDepth({ entityType })
  );

export async function getCommentSectionHandler({
  ctx,
  input,
}: {
  ctx: Context;
  input: GetCommentSectionInput;
}) {
  await assertCommentEntityVisible(input, ctx);
  const viewer = await viewerFor(ctx, input);
  const [page, lock] = await Promise.all([
    getCommentSection(kyselyV3Read, input, viewer, {
      sort: input.sort,
      cursor: input.cursor,
      budget: constants.comments.getV3PageBudget(input),
      replyDepth: replyDepth(input.entityType),
    }),
    getCommentLock(kyselyV3Read, input),
  ]);
  return { ...(await withAuthors(page)), locked: lock.locked };
}

/** A reply or deep link names a comment; its surface comes from the stored row, never the input. */
async function resolveComment(ctx: Context, commentId: number) {
  const entity = await getCommentEntity(kyselyV3Read, commentId);
  if (!entity) throw throwNotFoundError('Comment not found');
  await assertCommentEntityVisible(entity, ctx);
  return { entity, viewer: await viewerFor(ctx, entity) };
}

export async function getCommentRepliesHandler({
  ctx,
  input,
}: {
  ctx: Context;
  input: GetCommentRepliesInput;
}) {
  const { entity, viewer } = await resolveComment(ctx, input.parentId);
  const [page, lock] = await Promise.all([
    getCommentReplies(kyselyV3Read, input.parentId, viewer, {
      sort: input.sort,
      cursor: input.cursor,
    }),
    getCommentLock(kyselyV3Read, entity, input.parentId),
  ]);
  return { ...(await withAuthors(page)), locked: lock.locked };
}

export async function getCommentThreadHandler({
  ctx,
  input,
}: {
  ctx: Context;
  input: GetCommentThreadInput;
}) {
  const { entity, viewer } = await resolveComment(ctx, input.commentId);
  const thread = await getCommentThread(kyselyV3Read, input.commentId, viewer, {
    sort: input.sort,
    entity: { entityType: input.entityType, entityId: input.entityId },
  });
  if (!thread) throw throwNotFoundError('Comment not found');
  const [replies, lock] = await Promise.all([
    withAuthors({ ...thread.replies, comments: [thread.comment, ...thread.replies.comments] }),
    getCommentLock(kyselyV3Read, entity, input.commentId),
  ]);
  const [comment, ...rest] = replies.comments;
  return { ...thread, comment, replies: { ...replies, comments: rest }, locked: lock.locked };
}
