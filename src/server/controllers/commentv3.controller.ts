import type { Context, ProtectedContext } from '~/server/createContext';
import { constants } from '~/server/common/constants';
import { assertCommentEntityVisible } from '~/server/controllers/commentv2.controller';
import { dbWrite } from '~/server/db/client';
import { kyselyV3Read } from '~/server/db/kyselyDb';
import { onCommentCreated, onTopicCommentsRemoved } from '~/server/events/points/hooks';
import type {
  CommentV3IdInput,
  GetCommentRepliesInput,
  GetCommentSectionInput,
  GetCommentThreadInput,
  CreateCommentV3Input,
  UpdateCommentV3Input,
} from '~/server/schema/commentv3.schema';
import type { CommentConnectorInput } from '~/server/schema/commentv2.schema';
import {
  getBlockCheckOwnerIds,
  getContentOwnerIdForComment,
  throwIfBlockedByOwners,
} from '~/server/services/block-check.service';
import { throwOnBlockedCommentContent } from '~/server/services/blocklist.service';
import { getCommentExcludedUserIds } from '~/server/services/comment-exclusions.service';
import { hasEntityAccess } from '~/server/services/common.service';
import {
  afterCommentsV3Deleted,
  bulkSetCommentV3TosViolation,
  deleteCommentsV3UnlessHeld,
} from '~/server/services/commentv3/moderation.service';
import {
  contentKeptError,
  holdMarkerViewExists,
  isLegalHoldAbort,
} from '~/server/services/legal-hold.service';
import {
  getStoredComment,
  getV3WriteComment,
  insertComment,
  isCommentWriteLocked,
  isV3WriteSurface,
  prismaRunner,
  setCommentFlags,
  type StoredCommentV3,
  updateCommentContent,
} from '~/server/services/commentv3/write.service';
import { recordStickerUsage, spendStickerUses } from '~/server/services/sticker.service';
import { queueScamScan } from '~/server/services/text-scan/scam-scan-queue';
import { emptyReactionCounts } from '~/shared/utils/comment-reactions';
import {
  type CommentV3Item,
  type CommentV3Page,
  type CommentV3Viewer,
  getCommentEntity,
  getCommentLock,
  getCommentReplies,
  getCommentSection,
  getCommentThread,
} from '~/server/services/commentv3/read.service';
import { getCosmeticsAndProfilePicturesForUsers } from '~/server/services/user.service';
import {
  handleLogError,
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';

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

async function asNewItem(row: StoredCommentV3) {
  const [author, lookup] = await Promise.all([
    kyselyV3Read
      .selectFrom('User')
      .select(['id', 'username', 'deletedAt', 'image'])
      .where('id', '=', row.userId)
      .executeTakeFirst(),
    getCosmeticsAndProfilePicturesForUsers([row.userId]),
  ]);
  return {
    id: row.id,
    deleted: false,
    parentId: row.parentId,
    replyToId: row.replyToId,
    depth: row.depth,
    content: row.content,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    pinnedAt: row.pinnedAt,
    hidden: row.hidden,
    tosViolation: row.tosViolation,
    reactionCount: 0,
    user: author ? { ...author, ...lookup(author.id) } : null,
    reactions: emptyReactionCounts(),
    myReactions: [],
    replyCount: 0,
  } satisfies Omit<CommentV3Item, 'user'> & { user: CommentV3Item['user'] };
}

/** The live comment, on a surface that writes CommentV3, whose section the caller may see. */
async function writableComment(ctx: Context, id: number) {
  const comment = await getV3WriteComment(prismaRunner(dbWrite), id);
  if (!comment) throw throwNotFoundError('Comment not found');
  await assertCommentEntityVisible(comment, ctx);
  return comment;
}

const assertAuthorOrModerator = (ctx: ProtectedContext, comment: StoredCommentV3) => {
  if (!ctx.user.isModerator && comment.userId !== ctx.user.id) throw throwAuthorizationError();
};

/** The content owner may hide and pin in its section, as moderators may anywhere. */
async function assertSectionModerator(ctx: ProtectedContext, comment: StoredCommentV3) {
  if (ctx.user.isModerator) return;
  const { ownerId } = await getContentOwnerIdForComment(comment.id);
  if (ownerId !== ctx.user.id) throw throwAuthorizationError();
}

async function assertCanWrite(
  ctx: ProtectedContext,
  section: Entity,
  content: string,
  answered: (StoredCommentV3 | undefined)[]
) {
  const { id: userId, isModerator } = ctx.user;
  if (!isV3WriteSurface(section.entityType))
    throw throwBadRequestError(`Comments on ${section.entityType} are not written here yet.`);
  if (section.entityType === 'article') {
    const [access] = await hasEntityAccess({
      entityType: 'Article',
      entityIds: [section.entityId],
      userId,
      isModerator,
    });
    if (!access?.hasAccess)
      throw throwAuthorizationError('You do not have access to this resource.');
  }
  await throwOnBlockedCommentContent(content, { isModerator });
  await throwIfBlockedByOwners({
    userId,
    ownerIds: [
      ...answered.map((c) => c?.userId),
      ...(await getBlockCheckOwnerIds(section as Parameters<typeof getBlockCheckOwnerIds>[0])),
    ],
    isModerator,
  });
}

const getLiveComment = async (id: number | null | undefined) => {
  const row = id ? await getStoredComment(prismaRunner(dbWrite), id) : undefined;
  return row && !row.deletedAt ? row : undefined;
};

/** A new comment, or a reply: a reply's section is its parent's, never the input's. */
export async function createCommentV3Handler({
  ctx,
  input,
}: {
  ctx: ProtectedContext;
  input: CreateCommentV3Input;
}) {
  const userId = ctx.user.id;
  const parent = await getLiveComment(input.parentId);
  if (input.parentId && !parent)
    throw throwNotFoundError('The comment you are replying to no longer exists.');
  const section: Entity = parent ?? input;
  await assertCommentEntityVisible(section, ctx);
  await assertCanWrite(ctx, section, input.content, [parent]);

  const saved = await dbWrite.$transaction(async (tx) => {
    // The parent before the stickers, the lock order an edit takes, so the two cannot deadlock.
    if (parent) await getStoredComment(prismaRunner(tx), parent.id, 'FOR KEY SHARE');
    const charged = await spendStickerUses({
      userId,
      surface: 'comment',
      content: input.content,
      tx,
    });
    const row = await insertComment(prismaRunner(tx), {
      userId,
      entityType: section.entityType,
      entityId: section.entityId,
      parentId: parent?.id,
      content: input.content,
    });
    return { row, charged };
  });

  recordStickerUsage({
    track: ctx.track,
    userId,
    charged: saved.charged,
    entityType: 'comment',
    entityId: saved.row.id,
  });
  queueScamScan({ entityType: 'CommentV3', entityId: saved.row.id });
  void onCommentCreated({ userId, entityType: section.entityType, entityId: section.entityId });
  return asNewItem(saved.row);
}

/** An edit by the author or a moderator. */
export async function updateCommentV3Handler({
  ctx,
  input,
}: {
  ctx: ProtectedContext;
  input: UpdateCommentV3Input;
}) {
  const comment = await writableComment(ctx, input.id);
  assertAuthorOrModerator(ctx, comment);
  const [parent, answered] = await Promise.all([
    getLiveComment(comment.parentId),
    getLiveComment(comment.replyToId),
  ]);
  await assertCanWrite(ctx, comment, input.content, [parent, answered]);

  const saved = await dbWrite.$transaction(async (tx) => {
    const db = prismaRunner(tx);
    const parentPath = comment.path.split('.').slice(0, -1).join('.') || null;
    if (await isCommentWriteLocked(db, { ...comment, path: parentPath }))
      throw throwBadRequestError('comment thread locked');
    // Charged against the content as locked here, so two concurrent edits are not both charged
    // for the same new sticker.
    const current = await getStoredComment(db, comment.id, 'FOR UPDATE');
    if (!current || current.deletedAt) throw throwNotFoundError('Comment not found');
    const charged = await spendStickerUses({
      userId: ctx.user.id,
      surface: 'comment',
      content: input.content,
      previousContent: current.content,
      tx,
    });
    const row = await updateCommentContent(db, { id: comment.id, content: input.content });
    if (!row) throw throwNotFoundError('Comment not found');
    return { row, charged };
  });

  recordStickerUsage({
    track: ctx.track,
    userId: ctx.user.id,
    charged: saved.charged,
    entityType: 'comment',
    entityId: comment.id,
  });
  queueScamScan({ entityType: 'CommentV3', entityId: comment.id });
  return { id: comment.id, content: saved.row.content, updatedAt: saved.row.updatedAt };
}

/** Deletes a comment; one with replies stays as a placeholder for them (D6). */
export async function deleteCommentV3Handler({
  ctx,
  input,
}: {
  ctx: ProtectedContext;
  input: CommentV3IdInput;
}) {
  const comment = await writableComment(ctx, input.id);
  assertAuthorOrModerator(ctx, comment);
  // A comment kept for a hold is hidden for ToS instead, which its author cannot tell from a delete:
  // it goes from every read they get, and its points with it.
  const markerView = await holdMarkerViewExists();
  const result = await dbWrite
    .$transaction((tx) =>
      deleteCommentsV3UnlessHeld(tx, [comment.id], markerView, {
        byAuthor: comment.userId === ctx.user.id,
      })
    )
    .catch((e: unknown) => {
      throw isLegalHoldAbort(e) ? contentKeptError(false) : e;
    });
  await afterCommentsV3Deleted(result);
  if (result.retained.length) void onTopicCommentsRemoved([comment]);
  ctx.track.commentEvent({ type: 'Delete', commentId: comment.id }).catch(handleLogError);
  return { id: comment.id };
}

export async function toggleHideCommentV3Handler({
  ctx,
  input,
}: {
  ctx: ProtectedContext;
  input: CommentV3IdInput;
}) {
  const comment = await writableComment(ctx, input.id);
  await assertSectionModerator(ctx, comment);
  await dbWrite.$transaction((tx) =>
    setCommentFlags(prismaRunner(tx), [comment.id], { hidden: !comment.hidden })
  );
  return { id: comment.id, hidden: !comment.hidden };
}

export async function togglePinCommentV3Handler({
  ctx,
  input,
}: {
  ctx: ProtectedContext;
  input: CommentV3IdInput;
}) {
  const comment = await writableComment(ctx, input.id);
  await assertSectionModerator(ctx, comment);
  await dbWrite.$transaction((tx) =>
    setCommentFlags(prismaRunner(tx), [comment.id], { pinned: !comment.pinnedAt })
  );
  return { id: comment.id, pinned: !comment.pinnedAt };
}

/** Moderators only. */
export async function setTosViolationV3Handler({
  ctx,
  input,
}: {
  ctx: ProtectedContext;
  input: CommentV3IdInput;
}) {
  if (!ctx.user.isModerator) throw throwAuthorizationError();
  await writableComment(ctx, input.id);
  // An already-flagged comment counts 0 and is not an error: the action already holds.
  return bulkSetCommentV3TosViolation({ ids: [input.id], actor: { id: ctx.user.id, ip: ctx.ip } });
}
