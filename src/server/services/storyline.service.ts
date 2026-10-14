import type { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import { isPlacementBlocked } from '~/server/services/placement-moderation.service';
import { getAllHiddenForUser, getBlockedPairIds } from '~/server/services/user-preferences.service';
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
  STORYLINE_PATH_LIMIT,
  compareStorylineChildren,
  getStorylineChapterRank,
  getStorylineChapterTombstone,
  isStorylineCeilingLevel,
  storylineLevelAllowed,
} from '~/shared/utils/storyline';
import type { StorylineStatus } from '~/shared/utils/prisma/enums';

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
  maxNsfwLevel: true,
  tosViolation: true,
  createdAt: true,
} satisfies Prisma.StorylineSelect;

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
    select: storylineSelect,
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
  const [blocked, hidden] = await Promise.all([
    getBlockedPairIds(viewer.id),
    getAllHiddenForUser({ userId: viewer.id }),
  ]);
  return new Set([...blocked, ...hidden.hiddenUsers.map((u) => u.id)]);
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

  const parent = await db.storylineChapter.findUnique({
    where: { postId: parentPostId },
    select: {
      id: true,
      storylineId: true,
      depth: true,
      userId: true,
      storyline: { select: { userId: true, maxNsfwLevel: true, tosViolation: true } },
    },
  });
  if (!parent) throw throwBadRequestError('That post is not a chapter of a storyline');
  if (parent.storyline.tosViolation) throw throwBadRequestError('This storyline was taken down');
  // The storyline's owner and the author of the chapter being continued.
  const [ownerBlocked, authorBlocked] = await Promise.all([
    isBlockedPair(db, parent.storyline.userId, placerId),
    isBlockedPair(db, parent.userId, placerId),
  ]);
  if (ownerBlocked || authorBlocked)
    throw throwBadRequestError('Continuations are not available on this chapter');

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
 * Whether a post is a chapter of a live storyline, so the placement layer can refuse a
 * continuation on any other post at submission time. Not a full check: approval runs
 * `writeChapterEdgeForPlacement`, which re-checks everything against the primary, blocks
 * included.
 */
export async function isOpenStorylineChapter(postId: number) {
  const chapter = await dbWrite.storylineChapter.findUnique({
    where: { postId },
    select: { storyline: { select: { tosViolation: true } } },
  });
  return !!chapter && !chapter.storyline.tosViolation;
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
  userId,
  isModerator,
}: {
  postId: number;
  title: string;
  maxNsfwLevel: number;
  userId: number;
  isModerator?: boolean;
}) {
  if (!isStorylineCeilingLevel(maxNsfwLevel)) throw throwBadRequestError('Invalid maximum rating');
  await throwOnBlockedUserContent(title, { isModerator, surface: 'storyline' });

  try {
    return await dbWrite.$transaction(async (tx) => {
      await assertPostCanBeChapter(tx, { postId, authorId: userId, maxNsfwLevel });
      const storyline = await tx.storyline.create({
        data: { userId, title, maxNsfwLevel },
        select: { id: true },
      });
      const root = await tx.storylineChapter.create({
        data: { storylineId: storyline.id, postId, userId, depth: 0 },
        select: { id: true },
      });
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
  userId,
  isModerator,
}: {
  id: number;
  title?: string;
  status?: StorylineStatus;
  maxNsfwLevel?: number;
  userId: number;
  isModerator?: boolean;
}) {
  await getOwnedStoryline({ storylineId: id, userId, isModerator });
  if (maxNsfwLevel !== undefined && !isStorylineCeilingLevel(maxNsfwLevel))
    throw throwBadRequestError('Invalid maximum rating');
  if (title !== undefined)
    await throwOnBlockedUserContent(title, { isModerator, surface: 'storyline' });

  // Lowering the ceiling hides chapters above it at read time; nothing is deleted, so raising it
  // again brings them back.
  return dbWrite.storyline.update({
    where: { id },
    data: { title, status, maxNsfwLevel },
    select: storylineSelect,
  });
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
        storyline: { select: { userId: true, maxNsfwLevel: true, tosViolation: true } },
      },
    });
    if (!parent) throw throwNotFoundError('Chapter not found');
    if (parent.storyline.userId !== userId) throw throwAuthorizationError();
    if (parent.storyline.tosViolation) throw throwBadRequestError('This storyline was taken down');

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
    select: { parentChapterId: true, storylineId: true },
  });
  if (!edge) throw throwBadRequestError('The first chapter is always the main route');
  await getOwnedStoryline({ storylineId: edge.storylineId, userId, isModerator });

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
      collaborators: {
        select: {
          user: { select: { id: true, username: true, bannedAt: true, deletedAt: true } },
        },
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

  const { chapters: _chapters, collaborators, user, ...rest } = storyline;
  return {
    ...rest,
    user: { id: user.id, username: user.username },
    rootChapterId: root?.id ?? null,
    rootPostId: root?.postId ?? null,
    collaborators: collaborators
      .map((c) => c.user)
      .filter((u) => !u.bannedAt && !u.deletedAt && !blockedUserIds.has(u.id))
      .map(({ id, username }) => ({ id, username })),
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
        post: { select: { nsfwLevel: true } },
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
    if (isStorylineHidden(c.storyline, viewer, blockedUserIds)) continue;
    if (isStorylineOutsideLevel(c.storyline, viewer, browsingLevel)) continue;
    if (!c.post.nsfwLevel || outsideBrowsingLevel(c.post.nsfwLevel, browsingLevel)) continue;
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
  const rows = await dbRead.$queryRaw<{ id: number; postId: number | null; depth: number }[]>`
    WITH RECURSIVE path AS (
      SELECT c.id, c."postId", c.depth, 0 AS hops
      FROM "StorylineChapter" c
      WHERE c.id = ${chapterId}
      UNION ALL
      SELECT p.id, p."postId", p.depth, path.hops + 1
      FROM path
      JOIN "StorylineChapterEdge" e ON e."chapterId" = path.id
      JOIN "StorylineChapter" p ON p.id = e."parentChapterId"
      WHERE path.hops < ${maxHops}
    )
    SELECT id, "postId", depth FROM path ORDER BY depth
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
      viewer,
      maxNsfwLevel: storyline.maxNsfwLevel,
      browsingLevel,
      blockedUserIds,
    });
    return toPathChapter(row, post, tombstone);
  });

  return { storyline, chapters, hasEarlier: (rows[0]?.depth ?? 0) > 0 };
}

const childEdgeSelect = {
  canon: true,
  chapter: {
    select: {
      id: true,
      depth: true,
      userId: true,
      createdAt: true,
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
  readersByChapterId = new Map(),
}: {
  chapterId: number;
  viewer: Viewer;
  browsingLevel: number;
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

  const collaborators = await dbRead.storylineCollaborator.findMany({
    where: { storylineId: storyline.id },
    select: { userId: true },
  });
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
      viewer,
      maxNsfwLevel: storyline.maxNsfwLevel,
      browsingLevel,
      blockedUserIds,
    });
    return {
      ...toPathChapter(chapter, chapter.post, tombstone),
      rank,
      readers: readersByChapterId.get(chapter.id) ?? 0,
      createdAt: chapter.createdAt,
    };
  });

  // Reader counts order the list but are not returned: a fork's share of readers is shown only
  // once enough readers have chosen, and that rule belongs to the share read, not this one.
  children.sort((a, b) => compareStorylineChildren(a, b));
  return children
    .slice(0, STORYLINE_CHILDREN_LIMIT)
    .map(({ readers: _readers, ...child }) => child);
}
