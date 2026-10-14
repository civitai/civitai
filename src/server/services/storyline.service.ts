import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { env } from '~/env/server';
import { NsfwLevel } from '~/server/common/enums';
import { REDIS_KEYS } from '~/server/redis/client';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import {
  bustFetchThroughCache,
  fetchThroughCache,
  setFetchThroughCache,
} from '~/server/utils/cache-helpers';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import { isPlacementBlocked } from '~/server/services/placement-moderation.service';
import { enforceBlockedBrowsingTags } from '~/server/services/blocked-browsing-tags.service';
import { placementPriceRanges } from '~/server/services/placement.service';
import { logToAxiom } from '~/server/logging/client';
import {
  getAllHiddenForUser,
  getBlockedPairIds,
  HiddenUsers,
} from '~/server/services/user-preferences.service';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import type {
  StorylineChapterPost,
  StorylineChapterRank,
  StorylineTombstoneReason,
} from '~/shared/utils/storyline';
import {
  STORYLINE_CHILDREN_LIMIT,
  STORYLINE_MAX_COLLABORATORS,
  STORYLINE_MAX_CONTRIBUTORS,
  STORYLINE_PATH_LIMIT,
  compareStorylineChildren,
  getStorylineChapterRank,
  getStorylineChapterTombstone,
  isStorylineCeilingLevel,
  storylineLevelAllowed,
  storylineShareMinChoices,
  toStorylineForkShares,
} from '~/shared/utils/storyline';
import type { StorylineStatus, StorylineWhoCanContinue } from '~/shared/utils/prisma/enums';
import { STORYLINE_REFUSALS } from '~/shared/utils/storyline-placement';
import {
  allBrowsingLevelsFlag,
  getHighestBrowsingLevelBit,
} from '~/shared/constants/browsingLevel.constants';
import type { PlacementSpaceMode } from '~/shared/utils/placement';
import { effectivePlacementPrice, resolvePlacementSpace } from '~/shared/utils/placement';
import type { MediaType } from '~/shared/utils/prisma/enums';

type Db = Prisma.TransactionClient | typeof dbWrite;
type Viewer = { id: number; isModerator?: boolean } | undefined;

const chapterPostSelect = {
  id: true,
  userId: true,
  title: true,
  nsfwLevel: true,
  publishedAt: true,
  tosViolation: true,
  user: { select: { username: true, bannedAt: true, deletedAt: true } },
} satisfies Prisma.PostSelect;

const storylineSelect = {
  id: true,
  userId: true,
  title: true,
  status: true,
  whoCanContinue: true,
  maxNsfwLevel: true,
  tosViolation: true,
  createdAt: true,
} satisfies Prisma.StorylineSelect;

/** The owner's picks, for the page and the owner's picker. Not part of every read. */
const storylinePicksSelect = {
  coverImageId: true,
  heroImageId: true,
  heroImagePosition: true,
} satisfies Prisma.StorylineSelect;

/** A credited user as `UserAvatar` renders them, plus what decides whether they are shown. */
const castUserSelect = {
  ...userWithCosmeticsSelect,
  bannedAt: true,
} satisfies Prisma.UserSelect;

/** `chapterPostSelect` with its author's avatar and cosmetics, for the page's main route. */
const castChapterPostSelect = {
  ...chapterPostSelect,
  user: { select: castUserSelect },
} satisfies Prisma.PostSelect;

/** A credited user without the fields that only decided whether to show them. */
const toCastUser = <T extends { bannedAt: Date | null; deletedAt: Date | null }>({
  bannedAt: _bannedAt,
  deletedAt: _deletedAt,
  ...user
}: T) => user;

/** What the read paths need to decide whether the storyline is hidden from a viewer. */
const storylineReadSelect = {
  ...storylineSelect,
  user: { select: { id: true, username: true, bannedAt: true, deletedAt: true } },
  // The first chapter's level is the story's level for the reader's browsing-level gate.
  chapters: {
    where: { depth: 0 },
    select: { id: true, postId: true, post: { select: { nsfwLevel: true } } },
  },
} satisfies Prisma.StorylineSelect;

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Either user has blocked the other. The placement layer's primary-read check, run on `db` so a
 * caller inside a transaction reads through it.
 */
const isBlockedPair = (db: Db, a: number, b: number) =>
  a !== b && isPlacementBlocked({ ownerId: a, placerId: b }, db);

async function getOwnedStoryline({
  storylineId,
  userId,
  isModerator,
}: {
  storylineId: number;
  userId: number;
  isModerator?: boolean;
}) {
  const storyline = await dbWrite.storyline.findUnique({
    where: { id: storylineId },
    select: { ...storylineSelect, ...storylinePicksSelect },
  });
  if (!storyline) throw throwNotFoundError('Storyline not found');
  if (storyline.userId !== userId && !isModerator) throw throwAuthorizationError();
  return storyline;
}

/**
 * Hidden from this viewer entirely: taken down, its owner is banned or deleted, or the viewer and
 * the owner have blocked one another. Owners and moderators still see it.
 */
function isStorylineHidden(
  storyline: {
    userId: number;
    tosViolation: boolean;
    user: { bannedAt: Date | null; deletedAt: Date | null };
  },
  viewer: Viewer,
  blockedUserIds: ReadonlySet<number>
) {
  if (viewer?.isModerator) return false;
  if (viewer?.id === storyline.userId) return false;
  return (
    storyline.tosViolation ||
    !!storyline.user.bannedAt ||
    !!storyline.user.deletedAt ||
    blockedUserIds.has(storyline.userId)
  );
}

/**
 * Users whose work this viewer does not see: either side of a block, and anyone the viewer has
 * hidden. Their storylines are hidden and their chapters are tombstones.
 */
async function getViewerExcludedIds(viewer: Viewer): Promise<ReadonlySet<number>> {
  if (!viewer) return new Set();
  // The hidden-users cache alone, not the whole hidden-preferences object.
  const [blocked, hidden] = await Promise.all([
    getBlockedPairIds(viewer.id),
    HiddenUsers.getCached({ userId: viewer.id }),
  ]);
  return new Set([...hidden.map((u) => u.id), ...blocked]);
}

/** A level outside the reader's browsing level. 0 (unrated) is not "outside": nothing is known. */
const outsideBrowsingLevel = (nsfwLevel: number, browsingLevel: number) =>
  nsfwLevel !== 0 && (nsfwLevel & browsingLevel) === 0;

/**
 * Whether the story as a whole is outside the reader's browsing level, in which case nothing of
 * it is served: not its title, its cast, its path or its forks. The story is judged by its first
 * chapter, or by its ceiling when that chapter is gone or unrated. The owner and moderators are
 * exempt, as they are from every storyline-level hide.
 */
function isStorylineOutsideLevel(
  storyline: {
    userId: number;
    maxNsfwLevel: number;
    chapters: { post: { nsfwLevel: number } | null }[];
  },
  viewer: Viewer,
  browsingLevel: number
) {
  if (viewer?.isModerator || viewer?.id === storyline.userId) return false;
  const storyLevel = storyline.chapters[0]?.post?.nsfwLevel || storyline.maxNsfwLevel;
  return outsideBrowsingLevel(storyLevel, browsingLevel);
}

// ---------------------------------------------------------------------------
// Chapter writes
// ---------------------------------------------------------------------------

/**
 * Checks a post may become a chapter of this storyline, written by `authorId`. Shared by every
 * path that adds a chapter, so the rules cannot drift between them.
 */
async function assertPostCanBeChapter(
  db: Db,
  {
    postId,
    authorId,
    maxNsfwLevel,
  }: {
    postId: number;
    authorId: number;
    maxNsfwLevel: number;
  }
) {
  const post = await db.post.findUnique({
    where: { id: postId },
    select: {
      userId: true,
      nsfwLevel: true,
      publishedAt: true,
      tosViolation: true,
      storylineChapter: { select: { id: true } },
    },
  });
  if (!post) throw throwNotFoundError('Post not found');
  if (post.userId !== authorId) throw throwAuthorizationError('You can only add your own posts');
  if (post.tosViolation) throw throwBadRequestError('This post cannot be added to a storyline');
  if (!post.publishedAt || post.publishedAt > new Date())
    throw throwBadRequestError('Publish the post before adding it to a storyline');
  if (post.storylineChapter) throw throwBadRequestError('This post is already in a storyline');
  if (!post.nsfwLevel)
    throw throwBadRequestError('This post has not been rated yet. Try again once it has been');
  if (!storylineLevelAllowed({ postLevel: post.nsfwLevel, maxNsfwLevel }))
    throw throwBadRequestError("This post is rated above the storyline's maximum rating");
}

/**
 * Locks a parent chapter's row for the rest of the transaction, so two writers deciding its canon
 * child take turns instead of both choosing canon and one failing on the one-canon index.
 * NO KEY UPDATE, so it does not hold up other chapters being added under the same parent.
 */
const lockParentChapter = (db: Db, parentChapterId: number) =>
  db.$queryRaw`SELECT id FROM "StorylineChapter" WHERE id = ${parentChapterId} FOR NO KEY UPDATE`;

/**
 * Inserts a chapter under a parent, and marks it canon when the storyline's owner wrote it and
 * the parent has no canon child yet. Edges always point at the parent CHAPTER, never its post,
 * so a later takedown of the parent's post leaves this chapter attached.
 */
async function insertChildChapter(
  db: Db,
  {
    parent,
    ownerId,
    postId,
    authorId,
    placementId,
  }: {
    parent: { id: number; storylineId: number; depth: number };
    ownerId: number;
    postId: number;
    authorId: number;
    placementId?: number;
  }
) {
  const chapter = await db.storylineChapter.create({
    data: {
      storylineId: parent.storylineId,
      postId,
      userId: authorId,
      depth: parent.depth + 1,
      placementId,
    },
    select: { id: true },
  });

  let canon = false;
  if (authorId === ownerId) {
    await lockParentChapter(db, parent.id);
    const existingCanon = await db.storylineChapterEdge.findFirst({
      where: { parentChapterId: parent.id, canon: true },
      select: { chapterId: true },
    });
    canon = !existingCanon;
  }

  await db.storylineChapterEdge.create({
    data: {
      storylineId: parent.storylineId,
      chapterId: chapter.id,
      parentChapterId: parent.id,
      canon,
    },
  });

  return chapter.id;
}

/**
 * Called by the placement layer when a storyline placement is approved, inside the transaction
 * that flips it to approved: `parentPostId` is the placement's target and `postId` the
 * continuation from its payload. Touches Postgres only, through `db`, so it is safe inside that
 * transaction; a refusal throws a 400 and rolls the approval back.
 *
 * Idempotent on `placementId`: a replay returns the chapter the first call wrote, with
 * `created: false`. Concurrent approvals of one placement are serialised by the placement
 * layer's status flip, so only one call gets this far. An expired, declined or removed placement
 * never calls this, so it writes nothing.
 */
export async function writeChapterEdgeForPlacement(
  {
    placementId,
    parentPostId,
    postId,
    placerId,
  }: {
    placementId: number;
    parentPostId: number;
    postId: number;
    placerId: number;
  },
  // Required: outside a transaction the parent lock is a no-op, and a failed edge insert would
  // leave a chapter row without a parent that a replay then reports as already written.
  db: Prisma.TransactionClient
): Promise<{ chapterId: number; created: boolean }> {
  const existing = await db.storylineChapter.findUnique({
    where: { placementId },
    select: { id: true, postId: true },
  });
  if (existing) {
    if (existing.postId !== postId)
      throw throwBadRequestError('This continuation was already added with a different post');
    return { chapterId: existing.id, created: false };
  }

  if (postId === parentPostId) throw throwBadRequestError('A chapter cannot continue itself');

  // Re-checked at approval: the storyline may have been taken down, a block made, or the
  // setting changed to collaborators only since the continuation was submitted.
  const { parent } = await assertCanContinueStoryline({ parentPostId, placerId }, db);

  await assertPostCanBeChapter(db, {
    postId,
    authorId: placerId,
    maxNsfwLevel: parent.storyline.maxNsfwLevel,
  });

  const chapterId = await insertChildChapter(db, {
    parent,
    ownerId: parent.storyline.userId,
    postId,
    authorId: placerId,
    placementId,
  });
  return { chapterId, created: true };
}

/**
 * Whether `placerId` may continue the chapter that is `parentPostId`, for the placement layer at
 * submission and for `writeChapterEdgeForPlacement` at approval. Throws a 400 when the post is
 * not a chapter of a live storyline, when the storyline's owner or the chapter's author and the
 * placer are in a block, or when only collaborators may continue and the placer is not one.
 * Postgres only, through `db`. Closing a storyline to everyone (mode 'off') is the placement
 * layer's own check.
 */
export async function assertCanContinueStoryline(
  { parentPostId, placerId }: { parentPostId: number; placerId: number },
  db: Db = dbWrite
) {
  const parent = await db.storylineChapter.findUnique({
    where: { postId: parentPostId },
    select: {
      id: true,
      storylineId: true,
      depth: true,
      userId: true,
      removedAt: true,
      storyline: {
        select: { userId: true, maxNsfwLevel: true, tosViolation: true, whoCanContinue: true },
      },
    },
  });
  if (!parent || parent.removedAt || parent.storyline.tosViolation)
    throw throwBadRequestError(STORYLINE_REFUSALS.notAChapter);

  const ownerId = parent.storyline.userId;
  const [ownerBlocked, authorBlocked, collaborator] = await Promise.all([
    isBlockedPair(db, ownerId, placerId),
    isBlockedPair(db, parent.userId, placerId),
    db.storylineCollaborator.findUnique({
      where: { storylineId_userId: { storylineId: parent.storylineId, userId: placerId } },
      select: { userId: true },
    }),
  ]);
  if (ownerBlocked || authorBlocked)
    throw throwBadRequestError('Continuations are not available on this chapter');

  const isOwner = placerId === ownerId;
  const isCollaborator = !isOwner && !!collaborator;
  if (parent.storyline.whoCanContinue === 'Collaborators' && !isOwner && !isCollaborator)
    throw throwBadRequestError(STORYLINE_REFUSALS.collaboratorsOnly);

  return { storylineId: parent.storylineId, ownerId, isOwner, isCollaborator, parent };
}

/** `assertCanContinueStoryline` as a yes/no, for callers that only need to hide an affordance. */
export async function isOpenStorylineChapter(postId: number, placerId: number) {
  return assertCanContinueStoryline({ parentPostId: postId, placerId }).then(
    () => true,
    () => false
  );
}

// ---------------------------------------------------------------------------
// Storyline writes
// ---------------------------------------------------------------------------

const isUniqueViolation = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';

export async function createStoryline({
  postId,
  title,
  maxNsfwLevel,
  whoCanContinue,
  coverImageId,
  heroImageId,
  heroImagePosition,
  userId,
  isModerator,
}: {
  postId: number;
  title: string;
  maxNsfwLevel: number;
  whoCanContinue?: StorylineWhoCanContinue;
  coverImageId?: number | null;
  heroImageId?: number | null;
  heroImagePosition?: number;
  userId: number;
  isModerator?: boolean;
}) {
  if (!isStorylineCeilingLevel(maxNsfwLevel)) throw throwBadRequestError('Invalid maximum rating');
  await throwOnBlockedUserContent(title, { isModerator, surface: 'storyline' });

  try {
    return await dbWrite.$transaction(async (tx) => {
      await assertPostCanBeChapter(tx, { postId, authorId: userId, maxNsfwLevel });
      const storyline = await tx.storyline.create({
        data: { userId, title, maxNsfwLevel, whoCanContinue },
        select: { id: true },
      });
      const root = await tx.storylineChapter.create({
        data: { storylineId: storyline.id, postId, userId, depth: 0 },
        select: { id: true },
      });
      // Checked once chapter 1 exists, by the same rule as later picks: at this point that means
      // an image of the post the storyline starts from.
      const picks = { coverImageId, heroImageId, heroImagePosition };
      if (coverImageId || heroImageId || heroImagePosition !== undefined) {
        await assertStorylinePicks(tx, {
          storylineId: storyline.id,
          ownerId: userId,
          maxNsfwLevel,
          imageIds: [coverImageId, heroImageId],
        });
        await tx.storyline.update({ where: { id: storyline.id }, data: picks });
      }
      return { id: storyline.id, rootChapterId: root.id };
    });
  } catch (error) {
    // Two requests starting a storyline from the same post: the loser hits the unique postId.
    if (isUniqueViolation(error)) throw throwBadRequestError('This post is already in a storyline');
    throw error;
  }
}

export async function updateStoryline({
  id,
  title,
  status,
  maxNsfwLevel,
  whoCanContinue,
  coverImageId,
  heroImageId,
  heroImagePosition,
  userId,
  isModerator,
}: {
  id: number;
  title?: string;
  status?: StorylineStatus;
  maxNsfwLevel?: number;
  whoCanContinue?: StorylineWhoCanContinue;
  /** null clears the pick. */
  coverImageId?: number | null;
  heroImageId?: number | null;
  heroImagePosition?: number;
  userId: number;
  isModerator?: boolean;
}) {
  const current = await getOwnedStoryline({ storylineId: id, userId, isModerator });
  if (maxNsfwLevel !== undefined) {
    if (!isStorylineCeilingLevel(maxNsfwLevel))
      throw throwBadRequestError('Invalid maximum rating');
    if (maxNsfwLevel < current.maxNsfwLevel) await assertCeilingKeepsFirstChapter(id, maxNsfwLevel);
  }
  if (title !== undefined)
    await throwOnBlockedUserContent(title, { isModerator, surface: 'storyline' });
  // A moderator editing is held to the owner's rule: the picks are the owner's chapters'. A pick
  // sent back unchanged is not judged again, so the picker can resend the whole form after a
  // collaborator whose image it is has been removed.
  await assertStorylinePicks(dbWrite, {
    storylineId: id,
    ownerId: current.userId,
    maxNsfwLevel: maxNsfwLevel ?? current.maxNsfwLevel,
    imageIds: [
      coverImageId !== current.coverImageId ? coverImageId : undefined,
      heroImageId !== current.heroImageId ? heroImageId : undefined,
    ],
  });

  // Lowering the ceiling hides later chapters above it at read time; nothing is deleted, so
  // raising it again brings them back.
  // Closing a Complete storyline to continuations is left to the placement layer reading the
  // status, so there is no second switch here to disagree with it.
  return dbWrite.storyline.update({
    where: { id },
    data: {
      title,
      status,
      maxNsfwLevel,
      whoCanContinue,
      coverImageId,
      heroImageId,
      heroImagePosition,
    },
    select: { ...storylineSelect, ...storylinePicksSelect },
  });
}

/**
 * The cover and banner may only be images from this storyline's chapters written by its owner or
 * by an endorsed collaborator (the endorsement is their consent), not from removed chapters, and
 * rated within the ceiling. Anything else is refused, whatever the client offered.
 *
 * Checked when chosen only. A collaborator removed later leaves their image as the cover until
 * the owner changes it, unless the image itself is deleted. An image that later becomes hidden or
 * above a reader's level is replaced, for that reader, by chapter 1's first image they may see.
 */
async function assertStorylinePicks(
  db: Db,
  {
    storylineId,
    ownerId,
    maxNsfwLevel,
    imageIds,
  }: {
    storylineId: number;
    ownerId: number;
    maxNsfwLevel: number;
    /** undefined is no change and null clears: neither is checked. */
    imageIds: (number | null | undefined)[];
  }
) {
  const ids = [...new Set(imageIds.filter((imageId): imageId is number => !!imageId))];
  if (!ids.length) return;
  const [images, collaborators] = await Promise.all([
    db.image.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        nsfwLevel: true,
        minor: true,
        poi: true,
        post: {
          select: {
            storylineChapter: { select: { storylineId: true, userId: true, removedAt: true } },
          },
        },
      },
    }),
    db.storylineCollaborator.findMany({ where: { storylineId }, select: { userId: true } }),
  ]);
  const allowedAuthors = new Set([ownerId, ...collaborators.map((c) => c.userId)]);
  const byId = new Map(images.map((image) => [image.id, image]));
  for (const imageId of ids) {
    const image = byId.get(imageId);
    const chapter = image?.post?.storylineChapter;
    if (
      !image ||
      !chapter ||
      chapter.storylineId !== storylineId ||
      chapter.removedAt ||
      !allowedAuthors.has(chapter.userId)
    )
      throw throwBadRequestError(
        "Choose an image from your own chapters or an endorsed collaborator's"
      );
    // Never shown as a cover or banner (see storylineImageVisible), so refused rather than kept.
    if (image.minor || image.poi)
      throw throwBadRequestError('This image cannot be used as a cover or banner');
    if (!image.nsfwLevel)
      throw throwBadRequestError('This image has not been rated yet. Try again once it has been');
    if (!storylineLevelAllowed({ postLevel: image.nsfwLevel, maxNsfwLevel }))
      throw throwBadRequestError("This image is rated above the storyline's maximum rating");
  }
}

/**
 * A lowered ceiling may not drop below chapter 1's rating: that would tombstone the story's
 * opening for every reader. Later chapters may fall above it and are hidden. When chapter 1 is
 * gone, taken down, blocked or not yet rated there is nothing to keep, so any valid ceiling is
 * accepted. Only lowering is checked, so an owner whose chapter 1 was re-rated upwards can still
 * raise the ceiling towards it.
 */
async function assertCeilingKeepsFirstChapter(storylineId: number, maxNsfwLevel: number) {
  // The primary: the write that follows must not be judged on a replica's older rating.
  const root = await dbWrite.storylineChapter.findFirst({
    where: { storylineId, depth: 0 },
    select: { post: { select: { nsfwLevel: true, tosViolation: true } } },
  });
  const floor = firstChapterFloor(root?.post);
  if (floor !== null && floor > maxNsfwLevel)
    throw throwBadRequestError(
      "The maximum rating cannot be below your first chapter's rating. Choose a higher rating"
    );
}

/**
 * The rating chapter 1 holds the ceiling to: its most severe image. Null when there is nothing to
 * keep, because the post is gone, taken down, not yet rated or rated Blocked. Shared by the floor
 * and the owner's settings read, so the two cannot disagree.
 */
function firstChapterFloor(post: { nsfwLevel: number; tosViolation: boolean } | null | undefined) {
  if (!post || post.tosViolation || !post.nsfwLevel) return null;
  const highest = getHighestBrowsingLevelBit(post.nsfwLevel);
  return highest === NsfwLevel.Blocked ? null : highest;
}

/** The owner continuing their own story directly; everyone else continues through a placement. */
export async function addOwnerChapter({
  parentChapterId,
  postId,
  userId,
}: {
  parentChapterId: number;
  postId: number;
  userId: number;
}) {
  return dbWrite.$transaction(async (tx) => {
    const parent = await tx.storylineChapter.findUnique({
      where: { id: parentChapterId },
      select: {
        id: true,
        storylineId: true,
        depth: true,
        removedAt: true,
        storyline: { select: { userId: true, maxNsfwLevel: true, tosViolation: true } },
      },
    });
    if (!parent) throw throwNotFoundError('Chapter not found');
    if (parent.storyline.userId !== userId) throw throwAuthorizationError();
    if (parent.storyline.tosViolation) throw throwBadRequestError('This storyline was taken down');
    if (parent.removedAt) throw throwBadRequestError('A removed chapter cannot be continued');

    await assertPostCanBeChapter(tx, {
      postId,
      authorId: userId,
      maxNsfwLevel: parent.storyline.maxNsfwLevel,
    });
    const chapterId = await insertChildChapter(tx, {
      parent,
      ownerId: parent.storyline.userId,
      postId,
      authorId: userId,
    });
    return { chapterId };
  });
}

/** Makes one child the owner's main route out of its parent, replacing the previous one. */
export async function setCanonChapter({
  chapterId,
  userId,
  isModerator,
}: {
  chapterId: number;
  userId: number;
  isModerator?: boolean;
}) {
  const edge = await dbWrite.storylineChapterEdge.findFirst({
    where: { chapterId },
    select: {
      parentChapterId: true,
      storylineId: true,
      chapter: { select: { removedAt: true } },
    },
  });
  if (!edge) throw throwBadRequestError('The first chapter is always the main route');
  await getOwnedStoryline({ storylineId: edge.storylineId, userId, isModerator });
  if (edge.chapter.removedAt)
    throw throwBadRequestError('A removed chapter cannot be the main route');

  await dbWrite.$transaction(async (tx) => {
    await lockParentChapter(tx, edge.parentChapterId);
    await tx.storylineChapterEdge.updateMany({
      where: { parentChapterId: edge.parentChapterId, canon: true },
      data: { canon: false },
    });
    await tx.storylineChapterEdge.updateMany({
      where: { chapterId, parentChapterId: edge.parentChapterId },
      data: { canon: true },
    });
  });
}

export async function addStorylineCollaborator({
  storylineId,
  targetUserId,
  userId,
  isModerator,
}: {
  storylineId: number;
  targetUserId: number;
  userId: number;
  isModerator?: boolean;
}) {
  const storyline = await getOwnedStoryline({ storylineId, userId, isModerator });
  if (targetUserId === storyline.userId)
    throw throwBadRequestError('The owner is already part of their storyline');

  const target = await dbWrite.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, bannedAt: true, deletedAt: true },
  });
  if (!target || target.bannedAt || target.deletedAt) throw throwNotFoundError('User not found');
  if (await isBlockedPair(dbWrite, storyline.userId, targetUserId))
    throw throwBadRequestError('You cannot endorse this user');

  const count = await dbWrite.storylineCollaborator.count({ where: { storylineId } });
  if (count >= STORYLINE_MAX_COLLABORATORS)
    throw throwBadRequestError(
      `A storyline can have at most ${STORYLINE_MAX_COLLABORATORS} collaborators`
    );

  await dbWrite.storylineCollaborator.upsert({
    where: { storylineId_userId: { storylineId, userId: targetUserId } },
    create: { storylineId, userId: targetUserId },
    update: {},
  });
}

export async function removeStorylineCollaborator({
  storylineId,
  targetUserId,
  userId,
  isModerator,
}: {
  storylineId: number;
  targetUserId: number;
  userId: number;
  isModerator?: boolean;
}) {
  // A collaborator may also step down themselves.
  if (targetUserId !== userId) await getOwnedStoryline({ storylineId, userId, isModerator });
  await dbWrite.storylineCollaborator.deleteMany({ where: { storylineId, userId: targetUserId } });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * A storyline's header. Not found when it is hidden from this viewer, or when the story is
 * outside their browsing level: the title and cast belong to a story they could not open. The
 * story is judged by its first chapter, or by its ceiling when that chapter is gone or unrated.
 *
 * Discussion, v1: the storyline's discussion is the comment thread of its first chapter's post
 * (`rootPostId`). The feature brief asks for one discussion separate from each chapter's own
 * comments; a storyline-level thread needs a schema change and is a follow-up.
 */
export async function getStoryline({
  id,
  viewer,
  browsingLevel,
}: {
  id: number;
  viewer: Viewer;
  browsingLevel: number;
}) {
  const storyline = await dbRead.storyline.findUnique({
    where: { id },
    select: {
      ...storylineReadSelect,
      ...storylinePicksSelect,
      user: { select: castUserSelect },
      collaborators: {
        select: { user: { select: castUserSelect } },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!storyline) throw throwNotFoundError('Storyline not found');
  const blockedUserIds = await getViewerExcludedIds(viewer);
  if (
    isStorylineHidden(storyline, viewer, blockedUserIds) ||
    isStorylineOutsideLevel(storyline, viewer, browsingLevel)
  )
    throw throwNotFoundError('Storyline not found');

  const root = storyline.chapters[0];
  const shownUser = (u: { id: number; bannedAt: Date | null; deletedAt: Date | null }) =>
    !u.bannedAt && !u.deletedAt && !blockedUserIds.has(u.id);
  const collaborators = storyline.collaborators
    .map((c) => c.user)
    .filter(shownUser)
    .map(toCastUser);
  const collaboratorIds = new Set(storyline.collaborators.map((c) => c.user.id));
  const gate = getStorylineImageGate(viewer, browsingLevel, blockedUserIds);

  // A contributor is credited only through a chapter this reader would be shown: published,
  // rated, not taken down, within the story's ceiling and the reader's level. Otherwise the cast
  // list would name the author of a chapter the path shows as a tombstone.
  const ceilingMask = storyline.maxNsfwLevel * 2 - 1;
  const visibleChapter = Prisma.sql`
    c."removedAt" IS NULL
    AND p."tosViolation" = false AND p."publishedAt" < now() AND p."nsfwLevel" <> 0
    AND (p."nsfwLevel" & ${browsingLevel}::int) <> 0
    AND (p."nsfwLevel" & ~${ceilingMask}::int) = 0`;
  const castIds = [storyline.userId, ...collaboratorIds];
  const [counts, authors, castCounts, mainPath, chosen] = await Promise.all([
    dbRead.$queryRaw<{ chapters: number; contributors: number }[]>`
      SELECT COUNT(*)::int AS chapters,
        COUNT(DISTINCT c."userId") FILTER (WHERE p.id IS NOT NULL AND ${visibleChapter})::int
          AS contributors
      FROM "StorylineChapter" c
      LEFT JOIN "Post" p ON p.id = c."postId"
      WHERE c."storylineId" = ${id}
    `,
    // Everyone else credited, most visible chapters first.
    dbRead.$queryRaw<{ userId: number; chapterCount: number }[]>`
      SELECT c."userId", COUNT(*)::int AS "chapterCount" FROM "StorylineChapter" c
      JOIN "Post" p ON p.id = c."postId"
      WHERE c."storylineId" = ${id} AND c."userId" <> ${storyline.userId} AND ${visibleChapter}
      GROUP BY c."userId" ORDER BY COUNT(*) DESC, c."userId"
      LIMIT ${STORYLINE_MAX_CONTRIBUTORS}
    `,
    // The owner's and collaborators' own counts, which the list above may not reach.
    dbRead.$queryRaw<{ userId: number; chapterCount: number }[]>`
      SELECT c."userId", COUNT(*)::int AS "chapterCount" FROM "StorylineChapter" c
      JOIN "Post" p ON p.id = c."postId"
      WHERE c."storylineId" = ${id} AND c."userId" = ANY(${castIds}::int[]) AND ${visibleChapter}
      GROUP BY c."userId"
    `,
    root
      ? getStorylineMainPath({
          rootChapterId: root.id,
          storyline,
          viewer,
          browsingLevel,
          blockedUserIds,
          gate,
        })
      : [],
    getChosenStorylineImages(gate, [
      { storylineId: id, imageId: storyline.heroImageId },
      { storylineId: id, imageId: storyline.coverImageId },
    ]),
  ]);
  const contributorUsers = authors.length
    ? await dbRead.user.findMany({
        where: {
          id: { in: authors.map((a) => a.userId).filter((uid) => !collaboratorIds.has(uid)) },
        },
        select: castUserSelect,
      })
    : [];
  const contributorById = new Map(contributorUsers.map((u) => [u.id, u]));
  // Chapters this reader is shown, by author, as the credits count them.
  const chapterCountById = new Map(
    [...authors, ...castCounts].map((row) => [row.userId, row.chapterCount])
  );
  const chaptersBy = (userId: number) => chapterCountById.get(userId) ?? 0;

  const {
    chapters: _chapters,
    collaborators: _collaborators,
    user,
    coverImageId,
    heroImageId,
    ...rest
  } = storyline;
  const ownerUser = toCastUser(user);
  const isOwnerView = viewer?.id === storyline.userId || !!viewer?.isModerator;
  const firstChapter = mainPath[0]?.depth === 0 ? mainPath[0] : undefined;
  const banner = chosen(id, heroImageId);
  return {
    ...rest,
    user: ownerUser,
    // The banner: the owner's banner pick, else their cover pick, else chapter 1's first image,
    // each only if this reader may see it. Never a hidden pick shown blurred.
    heroImage: banner ?? chosen(id, coverImageId) ?? firstChapter?.firstImage ?? null,
    // Whether heroImage is the banner pick, so the page shows it as a wide banner at its focus
    // rather than a portrait it must blur. Readers get no pick ids to compare.
    heroIsBanner: !!banner,
    // The card's picture, as the feed shows it: the cover pick, else chapter 1's first image.
    coverImage: chosen(id, coverImageId) ?? firstChapter?.firstImage ?? null,
    // The raw picks, for the owner's picker only.
    coverImageId: isOwnerView ? coverImageId : null,
    heroImageId: isOwnerView ? heroImageId : null,
    rootChapterId: root?.id ?? null,
    // Chapter 1's post id, whatever this reader may see of it: for the discussion thread, not a
    // cover. Take a cover from the reading path, which tombstones chapter 1 where it must.
    rootPostId: root?.postId ?? null,
    chapterCount: counts[0]?.chapters ?? 0,
    contributorCount: counts[0]?.contributors ?? 0,
    viewerRole: !viewer
      ? null
      : viewer.id === storyline.userId
      ? ('owner' as const)
      : collaboratorIds.has(viewer.id)
      ? ('collaborator' as const)
      : null,
    collaborators,
    contributors: [
      { user: ownerUser, role: 'creator' as const, chapterCount: chaptersBy(ownerUser.id) },
      ...collaborators.map((u) => ({
        user: u,
        role: 'endorsed' as const,
        chapterCount: chaptersBy(u.id),
      })),
      ...authors
        .map((a) => contributorById.get(a.userId))
        .filter((u): u is NonNullable<typeof u> => !!u && shownUser(u))
        .map((u) => ({
          user: toCastUser(u),
          role: 'contributor' as const,
          chapterCount: chaptersBy(u.id),
        })),
    ],
    mainPath,
  };
}

/**
 * The owner's main route from the first chapter: each chapter's canon child in turn, at most
 * `STORYLINE_PATH_LIMIT` chapters, with tombstones as in the reading path and how many ways on
 * each chapter has.
 */
async function getStorylineMainPath({
  rootChapterId,
  storyline,
  viewer,
  browsingLevel,
  blockedUserIds,
  gate = getStorylineImageGate(viewer, browsingLevel, blockedUserIds),
}: {
  /** Where the route starts: chapter 1 for the whole route, any chapter for the canon after it. */
  rootChapterId: number;
  storyline: { maxNsfwLevel: number };
  viewer: Viewer;
  browsingLevel: number;
  blockedUserIds: ReadonlySet<number>;
  /** A caller reading other images for the same reader passes its own. */
  gate?: StorylineImageGateSource;
}) {
  const rows = await dbRead.$queryRaw<
    { id: number; postId: number | null; depth: number; removedAt: Date | null }[]
  >`
    WITH RECURSIVE main AS (
      SELECT c.id, c."postId", c.depth, c."removedAt", 0 AS hops
      FROM "StorylineChapter" c
      WHERE c.id = ${rootChapterId}
      UNION ALL
      SELECT ch.id, ch."postId", ch.depth, ch."removedAt", main.hops + 1
      FROM main
      JOIN "StorylineChapterEdge" e ON e."parentChapterId" = main.id AND e.canon
      JOIN "StorylineChapter" ch ON ch.id = e."chapterId"
      WHERE main.hops < ${STORYLINE_PATH_LIMIT - 1}
    )
    SELECT id, "postId", depth, "removedAt" FROM main ORDER BY depth
  `;
  if (!rows.length) return [];

  const chapterIds = rows.map((r) => r.id);
  const postIds = rows.flatMap((r) => (r.postId != null ? [r.postId] : []));
  const [posts, childCounts] = await Promise.all([
    postIds.length
      ? dbRead.post.findMany({ where: { id: { in: postIds } }, select: castChapterPostSelect })
      : [],
    dbRead.storylineChapterEdge.groupBy({
      by: ['parentChapterId'],
      where: { parentChapterId: { in: chapterIds } },
      _count: { _all: true },
    }),
  ]);
  const postById = new Map(posts.map((p) => [p.id, p]));
  const childCountById = new Map(childCounts.map((c) => [c.parentChapterId, c._count._all]));

  const route = rows.map((row) => {
    const post = row.postId != null ? postById.get(row.postId) ?? null : null;
    const tombstone = getStorylineChapterTombstone({
      post,
      removed: !!row.removedAt,
      viewer,
      maxNsfwLevel: storyline.maxNsfwLevel,
      browsingLevel,
      blockedUserIds,
    });
    const chapter = toPathChapter(row, post, tombstone);
    return {
      ...chapter,
      // The author as the page's cast shows them, on a chapter the reader is shown.
      post: chapter.post && post ? { ...chapter.post, user: toCastUser(post.user) } : null,
      childCount: childCountById.get(row.id) ?? 0,
    };
  });
  return withFirstImages(gate, route);
}

/**
 * The owner's main route after `chapterId`: its canon child, that chapter's canon child, and so on,
 * at most `STORYLINE_PATH_LIMIT - 1` chapters. Tombstones are kept, as in the reading path, so the
 * route stays followable past a removed chapter. Empty when the chapter has no canon child.
 */
export async function getStorylineCanonAhead({
  chapterId,
  viewer,
  browsingLevel,
}: {
  chapterId: number;
  viewer: Viewer;
  browsingLevel: number;
}) {
  const chapter = await dbRead.storylineChapter.findUnique({
    where: { id: chapterId },
    select: { storylineId: true },
  });
  if (!chapter) throw throwNotFoundError('Chapter not found');
  const { storyline, blockedUserIds } = await getStorylineForRead(
    chapter.storylineId,
    viewer,
    browsingLevel
  );
  const route = await getStorylineMainPath({
    rootChapterId: chapterId,
    storyline,
    viewer,
    browsingLevel,
    blockedUserIds,
  });
  // The route starts at the chapter asked about; the reader is already on it.
  return route.slice(1);
}

/**
 * Chapter ratings for the owner choosing a ceiling, so the settings can warn how many chapters a
 * lower one would hide. Owner and moderators only, and always as the owner sees the story: a
 * chapter the owner is shown as a tombstone (taken down, unpublished, by a banned author or one in
 * a block with them) is left out, its rating not theirs to see and not hidden by any ceiling.
 *
 * `rootNsfwLevel` is chapter 1's level, null when the floor has nothing to keep (see
 * `firstChapterFloor`); `chapterLevels` are the later chapters' levels, in depth order.
 */
export async function getStorylineChapterLevels({
  id,
  userId,
  isModerator,
}: {
  id: number;
  userId: number;
  isModerator?: boolean;
}) {
  const storyline = await getOwnedStoryline({ storylineId: id, userId, isModerator });
  const owner = { id: storyline.userId };
  const [rows, blockedUserIds] = await Promise.all([
    dbRead.$queryRaw<
      {
        depth: number;
        userId: number;
        nsfwLevel: number;
        publishedAt: Date | null;
        tosViolation: boolean;
        bannedAt: Date | null;
        deletedAt: Date | null;
        removedAt: Date | null;
      }[]
    >`
      SELECT c.depth, p."userId", p."nsfwLevel", p."publishedAt", p."tosViolation",
        u."bannedAt", u."deletedAt", c."removedAt"
      FROM "StorylineChapter" c
      JOIN "Post" p ON p.id = c."postId"
      JOIN "User" u ON u.id = p."userId"
      WHERE c."storylineId" = ${id}
      ORDER BY c.depth, c.id
    `,
    getViewerExcludedIds(owner),
  ]);
  const root = rows.find((row) => row.depth === 0);
  // Shown to the owner whatever the ceiling: judged at the highest ceiling and every level, so
  // only the reasons a ceiling cannot change are applied.
  const shownToOwner = (row: (typeof rows)[number]) =>
    !getStorylineChapterTombstone({
      post: { id: 0, ...row, user: { bannedAt: row.bannedAt, deletedAt: row.deletedAt } },
      removed: !!row.removedAt,
      viewer: owner,
      maxNsfwLevel: NsfwLevel.XXX,
      browsingLevel: allBrowsingLevelsFlag,
      blockedUserIds,
    });
  return {
    rootNsfwLevel: root && firstChapterFloor(root) !== null ? root.nsfwLevel : null,
    chapterLevels: rows
      .filter((row) => row.depth > 0 && shownToOwner(row))
      .map((row) => row.nsfwLevel),
  };
}

/**
 * Storyline membership for a page of posts, for the storyline pill on cards. One query for the
 * whole page. A post is left out when its storyline is hidden from this viewer or the post itself
 * is outside their browsing level, so the call cannot list stories the viewer could not open.
 */
export async function getStorylinesForPosts({
  postIds,
  viewer,
  browsingLevel,
}: {
  postIds: number[];
  viewer: Viewer;
  browsingLevel: number;
}) {
  if (!postIds.length) return {};
  const [chapters, blockedUserIds] = await Promise.all([
    dbRead.storylineChapter.findMany({
      where: { postId: { in: postIds } },
      select: {
        id: true,
        postId: true,
        depth: true,
        removedAt: true,
        post: { select: { nsfwLevel: true, userId: true } },
        storyline: {
          select: {
            id: true,
            title: true,
            userId: true,
            maxNsfwLevel: true,
            tosViolation: true,
            user: { select: { bannedAt: true, deletedAt: true } },
            chapters: { where: { depth: 0 }, select: { post: { select: { nsfwLevel: true } } } },
          },
        },
      },
    }),
    getViewerExcludedIds(viewer),
  ]);

  const byPost: Record<
    number,
    { chapterId: number; depth: number; storylineId: number; title: string }
  > = {};
  for (const c of chapters) {
    if (c.postId == null || !c.post) continue;
    // As getStorylineChapterTombstone: only moderators are shown a removed chapter.
    if (c.removedAt && !viewer?.isModerator) continue;
    if (isStorylineHidden(c.storyline, viewer, blockedUserIds)) continue;
    if (isStorylineOutsideLevel(c.storyline, viewer, browsingLevel)) continue;
    // The post's own author is told it is a chapter whatever their level, as the owner is.
    const isAuthor = viewer?.id === c.post.userId;
    if (!isAuthor && (!c.post.nsfwLevel || outsideBrowsingLevel(c.post.nsfwLevel, browsingLevel)))
      continue;
    byPost[c.postId] = {
      chapterId: c.id,
      depth: c.depth,
      storylineId: c.storyline.id,
      title: c.storyline.title,
    };
  }
  return byPost;
}

export type StorylinePathChapter =
  | {
      chapterId: number;
      depth: number;
      tombstone: null;
      post: { id: number; title: string | null; userId: number; username: string | null };
    }
  | { chapterId: number; depth: number; tombstone: StorylineTombstoneReason; post: null };

function toPathChapter(
  chapter: { id: number; depth: number },
  post: (StorylineChapterPost & { title: string | null; user: { username: string | null } }) | null,
  tombstone: StorylineTombstoneReason | null
): StorylinePathChapter {
  if (tombstone || !post)
    return {
      chapterId: chapter.id,
      depth: chapter.depth,
      tombstone: tombstone ?? 'deleted',
      post: null,
    };
  return {
    chapterId: chapter.id,
    depth: chapter.depth,
    tombstone: null,
    post: { id: post.id, title: post.title, userId: post.userId, username: post.user.username },
  };
}

async function getStorylineForRead(storylineId: number, viewer: Viewer, browsingLevel: number) {
  const storyline = await dbRead.storyline.findUnique({
    where: { id: storylineId },
    select: storylineReadSelect,
  });
  if (!storyline) throw throwNotFoundError('Storyline not found');
  const blockedUserIds = await getViewerExcludedIds(viewer);
  if (
    isStorylineHidden(storyline, viewer, blockedUserIds) ||
    isStorylineOutsideLevel(storyline, viewer, browsingLevel)
  )
    throw throwNotFoundError('Storyline not found');
  const { user: _user, chapters: _chapters, ...rest } = storyline;
  return { storyline: rest, blockedUserIds };
}

/**
 * The reading path ending at `chapterId`, in order. A chapter this reader may not see is a
 * tombstone carrying the reason, never an error, so the chapters after it stay reachable. v1
 * chapters have one parent, so the path is unique.
 *
 * At most `STORYLINE_PATH_LIMIT` chapters, the ones nearest `chapterId`; `hasEarlier` says the
 * path starts further back, and the reader pages back by asking for the first chapter returned.
 */
export async function getStorylinePath({
  chapterId,
  viewer,
  browsingLevel,
}: {
  chapterId: number;
  viewer: Viewer;
  browsingLevel: number;
}) {
  const target = await dbRead.storylineChapter.findUnique({
    where: { id: chapterId },
    select: { storylineId: true, depth: true },
  });
  if (!target) throw throwNotFoundError('Chapter not found');
  const { storyline, blockedUserIds } = await getStorylineForRead(
    target.storylineId,
    viewer,
    browsingLevel
  );

  // Bounded by the target's depth and the window, so a corrupt edge cannot loop forever.
  const maxHops = Math.min(target.depth, STORYLINE_PATH_LIMIT - 1);
  const rows = await dbRead.$queryRaw<
    { id: number; postId: number | null; depth: number; removedAt: Date | null }[]
  >`
    WITH RECURSIVE path AS (
      SELECT c.id, c."postId", c.depth, c."removedAt", 0 AS hops
      FROM "StorylineChapter" c
      WHERE c.id = ${chapterId}
      UNION ALL
      SELECT p.id, p."postId", p.depth, p."removedAt", path.hops + 1
      FROM path
      JOIN "StorylineChapterEdge" e ON e."chapterId" = path.id
      JOIN "StorylineChapter" p ON p.id = e."parentChapterId"
      WHERE path.hops < ${maxHops}
    )
    SELECT id, "postId", depth, "removedAt" FROM path ORDER BY depth
  `;

  const postIds = rows.flatMap((r) => (r.postId != null ? [r.postId] : []));
  const posts = postIds.length
    ? await dbRead.post.findMany({ where: { id: { in: postIds } }, select: chapterPostSelect })
    : [];
  const postById = new Map(posts.map((p) => [p.id, p]));

  const chapters = rows.map((row) => {
    const post = row.postId != null ? postById.get(row.postId) ?? null : null;
    const tombstone = getStorylineChapterTombstone({
      post,
      removed: !!row.removedAt,
      viewer,
      maxNsfwLevel: storyline.maxNsfwLevel,
      browsingLevel,
      blockedUserIds,
    });
    return toPathChapter(row, post, tombstone);
  });

  return {
    storyline,
    chapters: await withFirstImages(
      getStorylineImageGate(viewer, browsingLevel, blockedUserIds),
      chapters
    ),
    hasEarlier: (rows[0]?.depth ?? 0) > 0,
  };
}

const childEdgeSelect = {
  canon: true,
  chapter: {
    select: {
      id: true,
      depth: true,
      userId: true,
      createdAt: true,
      removedAt: true,
      post: { select: chapterPostSelect },
    },
  },
} satisfies Prisma.StorylineChapterEdgeSelect;

/**
 * The ways to continue from the end of a chapter, in end-of-chapter order: canon, then endorsed
 * collaborators, then everyone else by readers. Tombstoned children are kept, so a reader can
 * pass a removed chapter and reach what follows it.
 *
 * The canon child and collaborators' children are read on their own, so a parent with more
 * than `STORYLINE_CHILDREN_LIMIT` children still lists them first; the rest are the oldest up to
 * the limit. Readers are counted outside Postgres, so ordering by them happens here.
 */
export async function getStorylineChildren({
  chapterId,
  viewer,
  browsingLevel,
  readersByChapterId,
}: {
  chapterId: number;
  viewer: Viewer;
  browsingLevel: number;
  /** Defaults to the stored counts, read only once the reader is known to see the story. */
  readersByChapterId?: ReadonlyMap<number, number>;
}) {
  const parent = await dbRead.storylineChapter.findUnique({
    where: { id: chapterId },
    select: { storylineId: true },
  });
  if (!parent) throw throwNotFoundError('Chapter not found');
  const { storyline, blockedUserIds } = await getStorylineForRead(
    parent.storylineId,
    viewer,
    browsingLevel
  );

  const [collaborators, readers] = await Promise.all([
    dbRead.storylineCollaborator.findMany({
      where: { storylineId: storyline.id },
      select: { userId: true },
    }),
    readersByChapterId ?? getStorylineReaderCounts(chapterId),
  ]);
  const collaboratorIds = new Set(collaborators.map((c) => c.userId));

  const [canonEdge, collaboratorEdges, otherEdges] = await Promise.all([
    dbRead.storylineChapterEdge.findFirst({
      where: { parentChapterId: chapterId, canon: true },
      select: childEdgeSelect,
    }),
    collaboratorIds.size
      ? dbRead.storylineChapterEdge.findMany({
          where: { parentChapterId: chapterId, chapter: { userId: { in: [...collaboratorIds] } } },
          select: childEdgeSelect,
          orderBy: { createdAt: 'asc' },
          take: STORYLINE_CHILDREN_LIMIT,
        })
      : [],
    dbRead.storylineChapterEdge.findMany({
      where: { parentChapterId: chapterId },
      select: childEdgeSelect,
      orderBy: { createdAt: 'asc' },
      take: STORYLINE_CHILDREN_LIMIT,
    }),
  ]);

  const edges = new Map<number, (typeof otherEdges)[number]>();
  for (const edge of [...(canonEdge ? [canonEdge] : []), ...collaboratorEdges, ...otherEdges])
    if (!edges.has(edge.chapter.id)) edges.set(edge.chapter.id, edge);

  const children = [...edges.values()].map(({ canon, chapter }) => {
    const rank: StorylineChapterRank = getStorylineChapterRank({
      canon,
      authorId: chapter.userId,
      collaboratorIds,
    });
    const tombstone = getStorylineChapterTombstone({
      post: chapter.post,
      removed: !!chapter.removedAt,
      viewer,
      maxNsfwLevel: storyline.maxNsfwLevel,
      browsingLevel,
      blockedUserIds,
    });
    return {
      ...toPathChapter(chapter, chapter.post, tombstone),
      rank,
      readers: readers.get(chapter.id) ?? 0,
      createdAt: chapter.createdAt,
    };
  });

  // Reader counts order the list but are not returned: a fork's share of readers is shown only
  // once enough readers have chosen, and that rule belongs to the share read, not this one.
  children.sort((a, b) => compareStorylineChildren(a, b));
  return withFirstImages(
    getStorylineImageGate(viewer, browsingLevel, blockedUserIds),
    children.slice(0, STORYLINE_CHILDREN_LIMIT).map(({ readers: _readers, ...child }) => child)
  );
}

// ---------------------------------------------------------------------------
// Engagement: which way readers went, and who wants the "Create next section" tool
// ---------------------------------------------------------------------------
//
// In Postgres, one row per signed-in reader: a reader counts once per fork point by their latest
// choice, which is a primary key here. The direct ClickHouse writer skips every non-production
// deployment (`isProductionDeployment`, src/server/services/blocks/block-event-ingest.service.ts:80),
// so counts kept there would never move on a preview or dev deployment.

const forkCountsKey = (chapterId: number) =>
  `${REDIS_KEYS.CACHES.STORYLINE_FORK_COUNTS}:${chapterId}` as const;

/**
 * Readers' latest choice per way on from a chapter, as `[childChapterId, readers]` pairs. From the
 * primary, not a replica: it is read straight after a choice is written.
 */
async function readForkCounts(chapterId: number) {
  const rows = await dbWrite.storylineBranchChoice.groupBy({
    by: ['chapterId'],
    where: { parentChapterId: chapterId },
    _count: { _all: true },
  });
  return rows.map((r) => [r.chapterId, r._count._all] as [number, number]);
}

function getForkCounts(chapterId: number) {
  return fetchThroughCache(forkCountsKey(chapterId), () => readForkCounts(chapterId));
}

/** The ways-on reader counts as a map, for ordering children. */
export async function getStorylineReaderCounts(chapterId: number) {
  return new Map(await getForkCounts(chapterId));
}

/**
 * How the readers who chose at the end of a chapter went: each way on's count and share, once
 * `STORYLINE_SHARE_MIN_CHOICES` (default 1) choices have been made; below that, only the total.
 */
/** Not found unless this reader can see the storyline `chapterId` belongs to. */
async function assertStorylineReadableByChapter(
  chapterId: number,
  viewer: Viewer,
  browsingLevel: number,
  // The tracking writes pass the primary, so a chapter added seconds ago is found.
  db: Db | typeof dbRead = dbRead
) {
  const chapter = await db.storylineChapter.findUnique({
    where: { id: chapterId },
    select: { storylineId: true },
  });
  if (!chapter) throw throwNotFoundError('Chapter not found');
  await getStorylineForRead(chapter.storylineId, viewer, browsingLevel);
}

export async function getStorylineForkShares({
  chapterId,
  viewer,
  browsingLevel,
}: {
  chapterId: number;
  viewer: Viewer;
  browsingLevel: number;
}) {
  await assertStorylineReadableByChapter(chapterId, viewer, browsingLevel);
  const counts = await getStorylineReaderCounts(chapterId);
  return toStorylineForkShares(counts, storylineShareMinChoices(env.STORYLINE_SHARE_MIN_CHOICES));
}

/** A signed-in reader took `toChapterId` at the end of `fromChapterId`. Their latest choice counts. */
export async function recordStorylineBranchChoice({
  viewer,
  browsingLevel,
  fromChapterId,
  toChapterId,
}: {
  viewer: { id: number; isModerator?: boolean };
  browsingLevel: number;
  fromChapterId: number;
  toChapterId: number;
}) {
  const userId = viewer.id;
  // Only a reader who can see the story gets a say in how its ways on are ordered.
  await assertStorylineReadableByChapter(fromChapterId, viewer, browsingLevel, dbWrite);
  const edge = await dbWrite.storylineChapterEdge.findUnique({
    where: {
      chapterId_parentChapterId: { chapterId: toChapterId, parentChapterId: fromChapterId },
    },
    select: { chapterId: true },
  });
  if (!edge) throw throwBadRequestError('That chapter does not continue from this one');

  await dbWrite.storylineBranchChoice.upsert({
    where: { userId_parentChapterId: { userId, parentChapterId: fromChapterId } },
    create: { userId, parentChapterId: fromChapterId, chapterId: toChapterId },
    update: { chapterId: toChapterId },
  });
  // Written through rather than marked stale, so the reader's next read counts their choice even
  // when it loses the refill lock to a read beside it. The choice is saved by now: if the count
  // cannot be read, mark the entry stale as before rather than fail the request.
  const key = forkCountsKey(fromChapterId);
  try {
    await setFetchThroughCache(key, await readForkCounts(fromChapterId));
  } catch (error) {
    logToAxiom({
      name: 'storyline-engagement',
      type: 'warning',
      message: 'fork counts not written through after a choice; marked stale',
      chapterId: fromChapterId,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    await bustFetchThroughCache(key).catch(() => undefined);
  }
}

/**
 * A signed-in reader asked for the "Create next section" tool at the end of a chapter. Counted
 * once per reader per chapter (how many people want it, not how many clicks); signed-out clicks
 * are not counted in v1.
 */
export async function recordStorylineCreateClick({
  viewer,
  browsingLevel,
  chapterId,
}: {
  viewer: { id: number; isModerator?: boolean };
  browsingLevel: number;
  chapterId: number;
}) {
  const userId = viewer.id;
  await assertStorylineReadableByChapter(chapterId, viewer, browsingLevel, dbWrite);
  await dbWrite.storylineCreateClick.upsert({
    where: { userId_parentChapterId: { userId, parentChapterId: chapterId } },
    create: { userId, parentChapterId: chapterId },
    update: {},
  });
}

export async function joinStorylineEarlyAccess({
  userId,
  storylineId,
}: {
  userId: number;
  storylineId?: number;
}) {
  await dbWrite.storylineEarlyAccessSignup.upsert({
    where: { userId },
    create: { userId, storylineId },
    update: {},
  });
}

export async function getStorylineEarlyAccessStatus(userId: number) {
  const row = await dbRead.storylineEarlyAccessSignup.findUnique({
    where: { userId },
    select: { userId: true },
  });
  return { joined: !!row };
}

/** For moderators: how many people want the tool. */
export async function getStorylineEarlyAccessStats() {
  const [signups, [clicks]] = await Promise.all([
    dbRead.storylineEarlyAccessSignup.count(),
    dbRead.$queryRaw<{ readers: number; clicks: number }[]>`
      SELECT COUNT(DISTINCT "userId")::int AS readers, COUNT(*)::int AS clicks
      FROM "StorylineCreateClick"
    `,
  ]);
  return { signups, createClickReaders: clicks?.readers ?? 0, createClicks: clicks?.clicks ?? 0 };
}

// ---------------------------------------------------------------------------
// Discover
// ---------------------------------------------------------------------------

export type StorylineFeedCover = {
  id: number;
  url: string;
  type: MediaType;
  nsfwLevel: number;
  hash: string | null;
  width: number | null;
  height: number | null;
  userId: number;
  minor: boolean;
  poi: boolean;
};

/** What decides which storyline images one reader may be shown. */
type StorylineImageGate = {
  viewer: Viewer;
  browsingLevel: number;
  blockedUserIds: ReadonlySet<number>;
  hiddenImageIds: number[];
  hiddenTagIds: number[];
};

/**
 * The cached hidden set every image read applies (images and tags the reader hid, the tags
 * moderated for everyone, the site's defaults for a signed-out reader), plus the browsing-settings
 * exclusions every image feed applies server-side for this level.
 *
 * Read on first use and once per request, so a read with no image to show reads nothing.
 */
type StorylineImageGateSource = () => Promise<StorylineImageGate>;

function getStorylineImageGate(
  viewer: Viewer,
  browsingLevel: number,
  blockedUserIds: ReadonlySet<number>
): StorylineImageGateSource {
  let gate: Promise<StorylineImageGate> | undefined;
  return () =>
    (gate ??= (async () => {
      const enforced: { browsingLevel: number; excludedTagIds?: number[] } = { browsingLevel };
      const [hidden] = await Promise.all([
        getAllHiddenForUser(viewer ? { userId: viewer.id } : {}),
        enforceBlockedBrowsingTags(enforced, { id: viewer?.id, isModerator: viewer?.isModerator }),
      ]);
      return {
        viewer,
        browsingLevel,
        blockedUserIds,
        hiddenImageIds: hidden.hiddenImages.map((image) => image.id),
        hiddenTagIds: [
          ...new Set([
            ...hidden.hiddenTags.map((tag) => tag.id),
            ...(enforced.excludedTagIds ?? []),
          ]),
        ],
      };
    })());
}

/**
 * An image this reader may be shown from a storyline chapter: scanned, not taken down or awaiting
 * review, rated, inside the reader's level and the story's ceiling, not one they hid and not
 * carrying a tag they hid or the site excludes at their level, never a minor or real-person image,
 * and not from a private post that is not theirs. Expects `i` (Image), `p` (its Post) and `st`
 * (the Storyline its chapter is in).
 */
function storylineImageVisible(gate: StorylineImageGate) {
  const viewerId = gate.viewer?.id ?? -1;
  return Prisma.sql`i.ingestion = 'Scanned' AND i."tosViolation" = false AND i."needsReview" IS NULL
      AND i."acceptableMinor" = false
      -- Shown to everyone who sees the card or page, so no minor or real-person image.
      AND i.minor = false AND i.poi = false
      AND (p.availability <> 'Private' OR p."userId" = ${viewerId})
      AND i."nsfwLevel" <> 0
      AND (i."nsfwLevel" & ${gate.browsingLevel}::int) <> 0
      AND (i."nsfwLevel" & ~(st."maxNsfwLevel" * 2 - 1)) = 0
      AND i.id <> ALL(${gate.hiddenImageIds}::int[])
      -- A reader's own image is not hidden from them by their hidden tags, as in image reads.
      AND (NOT EXISTS (
        SELECT 1 FROM "TagsOnImageDetails" toi
        WHERE toi."imageId" = i.id AND toi."tagId" = ANY(${gate.hiddenTagIds}::int[])
          AND toi.disabled = false
      ) OR i."userId" = ${viewerId})`;
}

const storylineImageColumns = Prisma.sql`i.id, i.url, i.type, i."nsfwLevel", i.hash,
      i.width, i.height, i."userId", i.minor, i.poi`;

const toStorylineImage = (row: StorylineFeedCover): StorylineFeedCover => ({
  id: row.id,
  url: row.url,
  type: row.type,
  nsfwLevel: row.nsfwLevel,
  hash: row.hash,
  width: row.width,
  height: row.height,
  userId: row.userId,
  minor: row.minor,
  poi: row.poi,
});

/**
 * Each chapter post's first image this reader may be shown, in one query: keyed by post id; a
 * post with no such image has no entry, so a hidden first image falls through to the next. The
 * caller passes only chapters the reader is shown.
 */
async function getFirstStorylineImages(gate: StorylineImageGateSource, postIds: number[]) {
  if (!postIds.length) return new Map<number, StorylineFeedCover>();
  const rows = await dbRead.$queryRaw<(StorylineFeedCover & { postId: number })[]>`
    SELECT DISTINCT ON (i."postId") i."postId", ${storylineImageColumns}
    FROM "Image" i
    JOIN "StorylineChapter" c ON c."postId" = i."postId"
    JOIN "Storyline" st ON st.id = c."storylineId"
    JOIN "Post" p ON p.id = i."postId"
    WHERE i."postId" = ANY(${postIds}::int[])
      AND ${storylineImageVisible(await gate())}
    ORDER BY i."postId", i.index NULLS LAST, i.id
  `;
  return new Map(rows.map((row) => [row.postId, toStorylineImage(row)]));
}

/**
 * Adds each row's `firstImage`, in one query for all of them. A tombstone carries no post
 * (`toPathChapter`), so it gets none and is not asked about.
 */
async function withFirstImages<T extends { post: { id: number } | null }>(
  gate: StorylineImageGateSource,
  rows: T[]
) {
  const images = await getFirstStorylineImages(
    gate,
    rows.flatMap((row) => (row.post ? [row.post.id] : []))
  );
  return rows.map((row) => ({
    ...row,
    firstImage: row.post ? images.get(row.post.id) ?? null : null,
  }));
}

/**
 * Owners' chosen covers and banners this reader may be shown, in one query: the same gate as
 * first images, and the chapter the image is in must be one this reader is shown, judged as the
 * reading path judges it. Returns a lookup by storyline and image id, so an image counts only as
 * a pick of the storyline it belongs to.
 */
async function getChosenStorylineImages(
  gate: StorylineImageGateSource,
  picks: { storylineId: number; imageId: number | null }[]
) {
  const key = (storylineId: number, imageId: number) => `${storylineId}:${imageId}`;
  const imageIds = [...new Set(picks.flatMap((pick) => (pick.imageId ? [pick.imageId] : [])))];
  const found = new Map<string, StorylineFeedCover>();
  if (imageIds.length) {
    const resolved = await gate();
    const rows = await dbRead.$queryRaw<
      (StorylineFeedCover & {
        storylineId: number;
        postId: number;
        postUserId: number;
        postNsfwLevel: number;
        publishedAt: Date | null;
        postTosViolation: boolean;
        removedAt: Date | null;
        bannedAt: Date | null;
        deletedAt: Date | null;
        maxNsfwLevel: number;
      })[]
    >`
      SELECT ${storylineImageColumns}, c."storylineId", i."postId",
        p."userId" AS "postUserId", p."nsfwLevel" AS "postNsfwLevel", p."publishedAt",
        p."tosViolation" AS "postTosViolation", c."removedAt", pu."bannedAt", pu."deletedAt",
        st."maxNsfwLevel"
      FROM "Image" i
      JOIN "StorylineChapter" c ON c."postId" = i."postId"
      JOIN "Storyline" st ON st.id = c."storylineId"
      JOIN "Post" p ON p.id = i."postId"
      JOIN "User" pu ON pu.id = p."userId"
      WHERE i.id = ANY(${imageIds}::int[])
        AND ${storylineImageVisible(resolved)}
    `;
    for (const row of rows) {
      const tombstone = getStorylineChapterTombstone({
        post: {
          id: row.postId,
          userId: row.postUserId,
          nsfwLevel: row.postNsfwLevel,
          publishedAt: row.publishedAt,
          tosViolation: row.postTosViolation,
          user: { bannedAt: row.bannedAt, deletedAt: row.deletedAt },
        },
        removed: !!row.removedAt,
        viewer: resolved.viewer,
        maxNsfwLevel: row.maxNsfwLevel,
        browsingLevel: resolved.browsingLevel,
        blockedUserIds: resolved.blockedUserIds,
      });
      if (!tombstone) found.set(key(row.storylineId, row.id), toStorylineImage(row));
    }
  }
  return (storylineId: number, imageId: number | null) =>
    imageId ? found.get(key(storylineId, imageId)) ?? null : null;
}

/** Deepest offset the most-chapters order pages to. */
const STORYLINE_FEED_MAX_OFFSET = 1000;

export type StorylineFeedFilter = 'all' | 'ongoing' | 'complete' | 'open';
export type StorylineFeedSort = 'newest' | 'mostChapters';

/**
 * Storylines a reader may open, newest or with most chapters first. Hidden ones (taken down,
 * banned or deleted owner, an owner the reader blocked, was blocked by or hid) are left out, and
 * so is a story outside the reader's browsing level, judged as everywhere else by its first
 * chapter (or its ceiling when that chapter is gone or unrated).
 *
 * "open" means accepting continuations: the placement layer's mode for the storyline, falling
 * back to its owner's and then to the default 'review', is not 'off'.
 */
export async function getStorylinesInfinite({
  filter,
  sort,
  cursor = 0,
  limit,
  viewer,
  browsingLevel,
}: {
  filter: StorylineFeedFilter;
  sort: StorylineFeedSort;
  /** The last id seen when newest first; an offset when by most chapters. */
  cursor?: number;
  limit: number;
  viewer: Viewer;
  browsingLevel: number;
}) {
  const excluded = [...(await getViewerExcludedIds(viewer))];
  const viewerId = viewer?.id ?? -1;
  const isModerator = !!viewer?.isModerator;

  const where: Prisma.Sql[] = [
    Prisma.sql`(${isModerator} OR st."userId" = ${viewerId} OR (st."tosViolation" = false AND u."bannedAt" IS NULL AND u."deletedAt" IS NULL))`,
    // The story's level: chapter 1's, or the ceiling when chapter 1 is gone or unrated.
    Prisma.sql`(${isModerator} OR st."userId" = ${viewerId} OR (COALESCE(NULLIF(rp."nsfwLevel", 0), st."maxNsfwLevel") & ${browsingLevel}::int) <> 0)`,
  ];
  // One array parameter, not one bind per id: the list can run to tens of thousands.
  if (excluded.length) where.push(Prisma.sql`st."userId" <> ALL(${excluded}::int[])`);
  if (filter === 'ongoing') where.push(Prisma.sql`st.status = 'Ongoing'`);
  if (filter === 'complete') where.push(Prisma.sql`st.status = 'Complete'`);
  if (filter === 'open') {
    // A Complete storyline takes no continuations, whatever its space says.
    where.push(Prisma.sql`st.status <> 'Complete'`);
    where.push(Prisma.sql`COALESCE(ss.mode, us.mode, 'review') <> 'off'`);
    // Open to this reader: collaborators-only storylines are open only to their collaborators.
    where.push(Prisma.sql`(st."whoCanContinue" = 'Anyone' OR st."userId" = ${viewerId} OR EXISTS (
      SELECT 1 FROM "StorylineCollaborator" sc
      WHERE sc."storylineId" = st.id AND sc."userId" = ${viewerId}
    ))`);
  }
  // Newest pages by id (stable while storylines are added); most-chapters by offset, capped,
  // because its order depends on counts computed per storyline.
  if (sort === 'newest' && cursor) where.push(Prisma.sql`st.id < ${cursor}`);
  const offset = sort === 'mostChapters' ? Math.min(cursor, STORYLINE_FEED_MAX_OFFSET) : 0;

  const orderBy =
    sort === 'mostChapters' ? Prisma.sql`"chapterCount" DESC, st.id DESC` : Prisma.sql`st.id DESC`;

  const rows = await dbRead.$queryRaw<
    {
      id: number;
      title: string;
      status: StorylineStatus;
      userId: number;
      username: string | null;
      bannedAt: Date | null;
      deletedAt: Date | null;
      maxNsfwLevel: number;
      whoCanContinue: StorylineWhoCanContinue;
      isCollaborator: boolean;
      rootPostId: number | null;
      rootNsfwLevel: number | null;
      rootPublishedAt: Date | null;
      rootTosViolation: boolean | null;
      storylineMode: string | null;
      storylinePrice: number | null;
      userMode: string | null;
      userPrice: number | null;
      chapterCount: number;
      contributorCount: number;
      createdAt: Date;
      coverImageId: number | null;
    }[]
  >`
    SELECT st.id, st.title, st.status, st."userId", u.username, u."bannedAt", u."deletedAt",
      st."maxNsfwLevel", st."whoCanContinue",
      EXISTS (
        SELECT 1 FROM "StorylineCollaborator" vc
        WHERE vc."storylineId" = st.id AND vc."userId" = ${viewerId}
      ) AS "isCollaborator",
      rc."postId" AS "rootPostId", rp."nsfwLevel" AS "rootNsfwLevel",
      rp."publishedAt" AS "rootPublishedAt", rp."tosViolation" AS "rootTosViolation",
      ss.mode AS "storylineMode", ss.price AS "storylinePrice",
      us.mode AS "userMode", us.price AS "userPrice",
      cc."chapterCount", cc."contributorCount", st."createdAt", st."coverImageId"
    FROM "Storyline" st
    JOIN "User" u ON u.id = st."userId"
    LEFT JOIN "StorylineChapter" rc ON rc."storylineId" = st.id AND rc.depth = 0
    LEFT JOIN "Post" rp ON rp.id = rc."postId"
    LEFT JOIN "PlacementSpace" ss
      ON ss.surface = 'storyline' AND ss."entityType" = 'storyline' AND ss."entityId" = st.id
    LEFT JOIN "PlacementSpace" us
      ON us.surface = 'storyline' AND us."entityType" = 'user' AND us."entityId" = st."userId"
    CROSS JOIN LATERAL (
      SELECT COUNT(*)::int AS "chapterCount", COUNT(DISTINCT c."userId")::int AS "contributorCount"
      FROM "StorylineChapter" c WHERE c."storylineId" = st.id
    ) cc
    WHERE ${Prisma.join(where, ' AND ')}
    ORDER BY ${orderBy}
    OFFSET ${offset} LIMIT ${limit + 1}
  `;

  const page = rows.slice(0, limit);
  const blockedUserIds = new Set(excluded);
  // Chapter 1's post, judged for this reader as the reading path judges it: no cover from a
  // chapter they would be shown as a tombstone.
  const coverPostIds = page.flatMap((row) =>
    row.rootPostId != null &&
    !getStorylineChapterTombstone({
      post: {
        id: row.rootPostId,
        userId: row.userId,
        nsfwLevel: row.rootNsfwLevel ?? 0,
        publishedAt: row.rootPublishedAt,
        tosViolation: !!row.rootTosViolation,
        user: { bannedAt: row.bannedAt, deletedAt: row.deletedAt },
      },
      viewer,
      maxNsfwLevel: row.maxNsfwLevel,
      browsingLevel,
      blockedUserIds,
    })
      ? [row.rootPostId]
      : []
  );
  const gate = getStorylineImageGate(viewer, browsingLevel, blockedUserIds);
  const ownerIds = [...new Set(page.map((row) => row.userId))];
  const [chosen, covers, owners, priceRanges] = await Promise.all([
    getChosenStorylineImages(
      gate,
      page.map((row) => ({ storylineId: row.id, imageId: row.coverImageId }))
    ),
    getFirstStorylineImages(gate, coverPostIds),
    ownerIds.length
      ? dbRead.user.findMany({ where: { id: { in: ownerIds } }, select: castUserSelect })
      : [],
    // Display only: the continue path prices again. A failure here leaves the page without
    // prices rather than failing it for every reader.
    placementPriceRanges(
      page.map((row) => row.userId),
      'storyline'
    ).catch((error) => {
      logToAxiom({
        name: 'storyline-feed',
        type: 'warning',
        message: 'continue prices unavailable for a feed page',
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      return new Map<number, { max: number }>();
    }),
  ]);

  const ownerById = new Map(owners.map((owner) => [owner.id, toCastUser(owner)]));
  const items = page.map(
    ({
      userId,
      username,
      bannedAt: _bannedAt,
      deletedAt: _deletedAt,
      coverImageId,
      isCollaborator,
      rootNsfwLevel: _rootNsfwLevel,
      rootPublishedAt: _rootPublishedAt,
      rootTosViolation: _rootTosViolation,
      storylineMode,
      storylinePrice,
      userMode,
      userPrice,
      ...row
    }) => {
      // The placement layer's cascade, as `resolvePlacementSpaceFor` applies it to one target.
      const space = resolvePlacementSpace('storyline', {
        storyline:
          storylineMode != null
            ? { mode: storylineMode as PlacementSpaceMode, price: storylinePrice }
            : undefined,
        user:
          userMode != null ? { mode: userMode as PlacementSpaceMode, price: userPrice } : undefined,
      });
      const mayContinue =
        row.whoCanContinue === 'Anyone' || viewer?.id === userId || isCollaborator;
      return {
        ...row,
        user: ownerById.get(userId) ?? { id: userId, username },
        // The owner's pick when this reader may see it, else chapter 1's first image they may.
        coverImage:
          chosen(row.id, coverImageId) ??
          (row.rootPostId != null ? covers.get(row.rootPostId) ?? null : null),
        // What the "open" filter means, per card: the storyline accepts continuations and this
        // reader is among those it takes them from (its owner counts, as in the filter). A
        // Complete storyline takes none, whatever its space says, as the placement layer reads it.
        open: row.status !== 'Complete' && space.mode !== 'off' && mayContinue,
        // In Buzz, what a continuation costs now; null when the space is unpriced or the owner's
        // cap could not be read.
        continuePrice: priceRanges.has(userId)
          ? effectivePlacementPrice(space.price, priceRanges.get(userId)!.max)
          : null,
      };
    }
  );
  const more = rows.length > limit;
  const nextCursor = !more
    ? undefined
    : sort === 'newest'
    ? items[items.length - 1]?.id
    : offset + limit <= STORYLINE_FEED_MAX_OFFSET
    ? offset + limit
    : undefined;
  return { items, nextCursor };
}
