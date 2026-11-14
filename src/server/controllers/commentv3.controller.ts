import type { Context, ProtectedContext } from '~/server/createContext';
import { commentTrackTypes } from '~/server/clickhouse/tracker';
import type { CommentEntityType } from '~/shared/utils/prisma/enums';
import { constants } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { kyselyV3Read } from '~/server/db/kyselyDb';
import { onCommentCreated } from '~/server/events/points/hooks';
import type {
  CommentMuteInput,
  CommentSectionInput,
  CommentTargetType,
  CommentV3IdInput,
  GetCommentRepliesInput,
  GetCommentSectionInput,
  GetCommentThreadInput,
  GetTimedCommentsInput,
  CreateCommentV3Input,
  UpdateCommentV3Input,
} from '~/server/schema/commentv3.schema';
import {
  getBlockCheckOwnerIds,
  throwIfBlockedByOwners,
} from '~/server/services/block-check.service';
import { throwOnBlockedCommentContent } from '~/server/services/blocklist.service';
import { getCommentExcludedUserIds } from '~/server/services/comment-exclusions.service';
import {
  afterCommentsV3Deleted,
  bulkSetCommentV3TosViolation,
  deleteCommentsV3,
} from '~/server/services/commentv3/moderation.service';
import {
  getStoredComment,
  getV3WriteComment,
  prismaRunner,
  setCommentFlags,
  toggleCommentLock,
  type StoredCommentV3,
} from '~/server/services/commentv3/write.service';
import { type CommentReadContext, commentSurface } from '~/server/services/commentv3/surfaces';
import {
  writeCommentEdit,
  writeNewComment,
} from '~/server/services/commentv3/comment-write.service';
import {
  getSectionMuted,
  getCommentMuted,
  toggleSectionLock,
  toggleSectionMute,
  toggleCommentMute,
} from '~/server/services/commentv3/section.service';
import {
  getCommentSong,
  type TimedCommentMetadata,
} from '~/server/services/commentv3/timed-comments.service';
import { SONGS_UNAVAILABLE_MESSAGE } from '~/shared/form-graph/generation/audio/song-metadata';
import { emptyReactionCounts } from '~/shared/utils/comment-reactions';
import {
  type CommentV3Item,
  type CommentV3Page,
  type CommentV3Viewer,
  getCommentEntity,
  getCommentLock,
  getCommentReplies,
  countSectionComments,
  getCommentSection,
  getCommentThread,
  getTimedComments,
  resolveModelPageCommentId,
} from '~/server/services/commentv3/read.service';
import {
  getCosmeticsAndProfilePicturesForUsers,
  getProfilePicturesForUsers,
} from '~/server/services/user.service';
import { removeTags } from '~/utils/string-helpers';
import {
  handleLogError,
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';

type Entity = { entityType: string; entityId: number };

async function assertSectionVisible(section: Entity, ctx: CommentReadContext) {
  await commentSurface(section.entityType).assertVisible?.(section.entityId, ctx);
}

async function sectionOwnerId({ entityType, entityId }: Entity) {
  const [ownerId] = await getBlockCheckOwnerIds({
    entityType: entityType as Parameters<typeof getBlockCheckOwnerIds>[0]['entityType'],
    entityId,
  });
  return ownerId;
}

/** The viewer, with the comment authors they must not see on this entity. */
async function viewerFor(ctx: Context, entity: Entity): Promise<CommentV3Viewer> {
  return {
    userId: ctx.user?.id,
    isModerator: !!ctx.user?.isModerator,
    excludedUserIds: await getCommentExcludedUserIds({
      entityType: entity.entityType as CommentTargetType,
      entityId: entity.entityId,
      userId: ctx.user?.id,
    }),
  };
}

/** Fills each author's profile picture and cosmetics from the user caches, as the v2 reads do. */
async function withAuthors(page: CommentV3Page) {
  const lookup = await getCosmeticsAndProfilePicturesForUsers(
    page.comments.flatMap((c) => (c.user ? [c.user.id] : [])),
    { showcaseHat: true }
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
  const [, viewer] = await Promise.all([assertSectionVisible(input, ctx), viewerFor(ctx, input)]);
  const leavesOutHidden = constants.comments.leavesOutHiddenComments(input);
  const [page, lock, counts] = await Promise.all([
    getCommentSection(kyselyV3Read, input, viewer, {
      sort: input.sort,
      cursor: input.cursor,
      budget: constants.comments.getV3PageBudget(input),
      replyDepth: replyDepth(input.entityType),
      hidden: leavesOutHidden ? (input.hidden ? 'only' : 'exclude') : undefined,
    }),
    getCommentLock(kyselyV3Read, input),
    // A section that leaves its hidden comments out says how many there are, on its first page.
    leavesOutHidden && !input.cursor
      ? countSectionComments(kyselyV3Read, input, viewer)
      : undefined,
  ]);
  return { ...(await withAuthors(page)), locked: lock.locked, counts };
}

const TIMED_COMMENT_TEXT_LENGTH = 140;

/**
 * A song's timed comments for the player's waveform, as plain text, under the section's own
 * visibility and exclusions. None while songs are off for the viewer.
 */
export async function getTimedCommentsHandler({
  ctx,
  input,
}: {
  ctx: Context;
  input: GetTimedCommentsInput;
}) {
  if (!ctx.features?.music) return [];
  const section = { entityType: 'image', entityId: input.imageId };
  const [, viewer] = await Promise.all([
    assertSectionVisible(section, ctx),
    viewerFor(ctx, section),
  ]);
  const comments = await getTimedComments(kyselyV3Read, section, viewer);
  const pictures = comments.length
    ? await getProfilePicturesForUsers([...new Set(comments.map((c) => c.user.id))])
    : {};
  return comments.map(({ content, ...comment }) => {
    const text = removeTags(content);
    return {
      ...comment,
      text:
        text.length > TIMED_COMMENT_TEXT_LENGTH
          ? `${text.slice(0, TIMED_COMMENT_TEXT_LENGTH - 1)}…`
          : text,
      user: { ...comment.user, profilePicture: pictures[comment.user.id] ?? null },
    };
  });
}

/** A reply or deep link names a comment; its surface comes from the stored row, never the input. */
async function resolveComment(ctx: Context, commentId: number) {
  const entity = await getCommentEntity(kyselyV3Read, commentId);
  if (!entity) throw throwNotFoundError('Comment not found');
  await assertSectionVisible(entity, ctx);
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
  const isModel = input.entityType === 'model';
  const [commentId, highlightId] = await Promise.all([
    isModel
      ? resolveModelPageCommentId(kyselyV3Read, input.entityId, input.commentId)
      : input.commentId,
    isModel && input.highlight
      ? resolveModelPageCommentId(kyselyV3Read, input.entityId, input.highlight)
      : input.highlight,
  ]);
  const { entity, viewer } = await resolveComment(ctx, commentId);
  const thread = await getCommentThread(kyselyV3Read, commentId, viewer, {
    sort: input.sort,
    entity: { entityType: input.entityType, entityId: input.entityId },
  });
  if (!thread) throw throwNotFoundError('Comment not found');
  const [replies, lock] = await Promise.all([
    withAuthors({ ...thread.replies, comments: [thread.comment, ...thread.replies.comments] }),
    getCommentLock(kyselyV3Read, entity, commentId),
  ]);
  const [comment, ...rest] = replies.comments;
  return {
    ...thread,
    comment,
    replies: { ...replies, comments: rest },
    locked: lock.locked,
    highlightId,
  };
}

async function asNewItem(row: StoredCommentV3, metadata?: TimedCommentMetadata) {
  const [author, lookup] = await Promise.all([
    kyselyV3Read
      .selectFrom('User')
      .select(['id', 'username', 'deletedAt', 'image'])
      .where('id', '=', row.userId)
      .executeTakeFirst(),
    getCosmeticsAndProfilePicturesForUsers([row.userId], { showcaseHat: true }),
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
    locked: row.locked,
    reactionCount: 0,
    user: author ? { ...author, ...lookup(author.id) } : null,
    reactions: emptyReactionCounts(),
    myReactions: [],
    replyCount: 0,
    timestampSec: metadata?.timestampSec ?? null,
  } satisfies Omit<CommentV3Item, 'user'> & { user: CommentV3Item['user'] };
}

/** The live comment, on a surface that writes CommentV3, whose section the caller may see. */
async function writableComment(ctx: Context, id: number) {
  const comment = await getV3WriteComment(prismaRunner(dbWrite), id);
  if (!comment) throw throwNotFoundError('Comment not found');
  await assertSectionVisible(comment, ctx);
  return comment;
}

const assertAuthorOrModerator = (ctx: ProtectedContext, comment: StoredCommentV3) => {
  if (!ctx.user.isModerator && comment.userId !== ctx.user.id) throw throwAuthorizationError();
};

/** A comment removed for ToS is not found to a member; only a moderator acts on it. */
const assertNotRemovedForMember = (ctx: ProtectedContext, comment: StoredCommentV3) => {
  if (comment.tosViolation && !ctx.user.isModerator) throw throwNotFoundError('Comment not found');
};

/** A storyline taken down for ToS refuses its owner here too (assertWritable). */
async function assertSectionOwnerOrModerator(ctx: ProtectedContext, comment: StoredCommentV3) {
  if (ctx.user.isModerator) return;
  if ((await sectionOwnerId(comment)) !== ctx.user.id) throw throwAuthorizationError();
  await commentSurface(comment.entityType).assertWritable?.(comment.entityId, ctx);
}

/**
 * For a member's action on one comment (react, report, mute): a comment they cannot see answers as
 * missing; a storyline taken down for ToS refuses the action. Returns the stored comment it read,
 * so a caller need not read it again.
 */
export async function assertCommentActionable(commentId: number, ctx: ProtectedContext) {
  const comment = await getV3WriteComment(prismaRunner(dbWrite), commentId);
  if (ctx.user.isModerator) return comment;
  if (!comment || comment.tosViolation) throw throwNotFoundError(`No comment with id ${commentId}`);
  await assertSectionVisible(comment, ctx);
  if (comment.entityType === 'storyline')
    await commentSurface('storyline').assertWritable?.(comment.entityId, ctx);
  return comment;
}

async function assertCanWrite(
  ctx: ProtectedContext,
  section: Entity,
  content: string,
  answered: (StoredCommentV3 | undefined)[]
) {
  const { id: userId, isModerator } = ctx.user;
  const surface = commentSurface(section.entityType);
  await surface.assertWritable?.(section.entityId, ctx);
  await surface.assertOpen?.(section.entityId, ctx);
  await throwOnBlockedCommentContent(content, { isModerator });
  await throwIfBlockedByOwners({
    userId,
    ownerIds: [...answered.map((c) => c?.userId), await sectionOwnerId(section)],
    isModerator,
  });
}

/**
 * The metadata a new comment stores for `timestampSec`, built here from that number alone. A time is
 * only for a top-level comment on a song, within the song's stored length.
 */
async function timedCommentMetadata(
  ctx: ProtectedContext,
  section: Entity,
  isReply: boolean,
  timestampSec: number | undefined
): Promise<TimedCommentMetadata | undefined> {
  if (timestampSec === undefined) return undefined;
  if (!ctx.features?.music) throw throwAuthorizationError(SONGS_UNAVAILABLE_MESSAGE);
  if (isReply) throw throwBadRequestError('A reply cannot be pinned to a time in the song.');
  const song =
    section.entityType === 'image' ? await getCommentSong(kyselyV3Read, section.entityId) : null;
  if (!song) throw throwBadRequestError('Only a comment on a song can be pinned to a time.');
  // Without a stored length the time cannot be checked against the song.
  if (song.durationSec === null)
    throw throwBadRequestError('This song cannot take comments at a time.');
  if (timestampSec > song.durationSec)
    throw throwBadRequestError('That time is past the end of the song.');
  return { timestampSec: Math.floor(timestampSec) };
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
  if (parent) assertNotRemovedForMember(ctx, parent);
  const section: Entity = parent ?? input;
  await assertSectionVisible(section, ctx);
  await assertCanWrite(ctx, section, input.content, [parent]);
  const metadata = await timedCommentMetadata(ctx, section, !!parent, input.timestampSec);

  const row = await writeNewComment({
    userId,
    section,
    parent,
    content: input.content,
    metadata,
    track: ctx.track,
  });
  const surface = commentSurface(section.entityType);
  // The cast is safe: commentSurface above throws for any other entity type.
  const trackType = parent ? 'Comment' : commentTrackTypes[section.entityType as CommentEntityType];
  const tracked =
    surface.trackAs?.(row) ?? (trackType ? { type: trackType, entityId: row.id } : undefined);
  if (tracked) ctx.track.comment({ ...tracked, nsfw: false }).catch(handleLogError);
  surface.onCreated?.(row, ctx);
  void onCommentCreated({ userId, entityType: section.entityType, entityId: section.entityId });
  return asNewItem(row, metadata);
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
  assertNotRemovedForMember(ctx, comment);
  const [parent, answered] = await Promise.all([
    getLiveComment(comment.parentId),
    getLiveComment(comment.replyToId),
  ]);
  await assertCanWrite(ctx, comment, input.content, [parent, answered]);

  const row = await writeCommentEdit({
    userId: ctx.user.id,
    comment,
    content: input.content,
    track: ctx.track,
  });
  return { id: comment.id, content: row.content, updatedAt: row.updatedAt };
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
  assertNotRemovedForMember(ctx, comment);
  afterCommentsV3Deleted(await dbWrite.$transaction((tx) => deleteCommentsV3(tx, [comment.id])));
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
  assertNotRemovedForMember(ctx, comment);
  await assertSectionOwnerOrModerator(ctx, comment);
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
  assertNotRemovedForMember(ctx, comment);
  await assertSectionOwnerOrModerator(ctx, comment);
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

export async function toggleCommentLockV3Handler({
  ctx,
  input,
}: {
  ctx: ProtectedContext;
  input: CommentV3IdInput;
}) {
  if (!ctx.user.isModerator) throw throwAuthorizationError();
  const comment = await writableComment(ctx, input.id);
  const row = await dbWrite.$transaction((tx) => toggleCommentLock(prismaRunner(tx), comment.id));
  if (!row) throw throwNotFoundError(`No comment with id ${comment.id}`);
  return { id: comment.id, locked: row.locked };
}

export async function getSectionLockHandler({
  ctx,
  input,
}: {
  ctx: Context;
  input: CommentSectionInput;
}) {
  await assertSectionVisible(input, ctx);
  return { locked: (await getCommentLock(kyselyV3Read, input)).locked };
}

export async function toggleSectionLockHandler({
  ctx,
  input,
}: {
  ctx: ProtectedContext;
  input: CommentSectionInput;
}) {
  if (!ctx.user.isModerator) throw throwAuthorizationError();
  return toggleSectionLock(input);
}

export async function getSectionMutedHandler({
  ctx,
  input,
}: {
  ctx: ProtectedContext;
  input: CommentSectionInput;
}) {
  await assertSectionVisible(input, ctx);
  return getSectionMuted({ ...input, userId: ctx.user.id });
}

export async function toggleSectionMuteHandler({
  ctx,
  input,
}: {
  ctx: ProtectedContext;
  input: CommentSectionInput;
}) {
  await assertSectionVisible(input, ctx);
  return toggleSectionMute({ ...input, userId: ctx.user.id });
}

export async function getCommentMutedHandler({
  ctx,
  input,
}: {
  ctx: ProtectedContext;
  input: CommentMuteInput;
}) {
  const comment = await assertCommentActionable(input.commentId, ctx);
  return getCommentMuted({ ...input, userId: ctx.user.id }, { comment });
}

export async function toggleCommentMuteHandler({
  ctx,
  input,
}: {
  ctx: ProtectedContext;
  input: CommentMuteInput;
}) {
  const comment = await assertCommentActionable(input.commentId, ctx);
  return toggleCommentMute({ ...input, userId: ctx.user.id }, { comment });
}
