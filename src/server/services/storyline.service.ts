import { uniqBy } from 'lodash-es';
import type { ImageInput } from '~/server/schema/image.schema';
import { TRPCError } from '@trpc/server';
import {
  COVER_IMAGE_UNAVAILABLE_MESSAGE,
  resolveCoverImageId,
} from '~/server/services/cover-image.service';
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
import type { StorylineModActivity } from '~/server/services/moderator.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { placementMoneyInFlightSql } from '~/server/services/placement-escrow.service';
import {
  accountHoldSql,
  contentKeptError,
  holdMarkerViewExists,
  ownerHeldSql,
} from '~/server/services/legal-hold.service';
import { isPlacementBlocked } from '~/server/services/placement-moderation.service';
import { enforceBlockedBrowsingTags } from '~/server/services/blocked-browsing-tags.service';
import { placementPriceRanges } from '~/server/services/placement.service';
import { raiseNsfwLevelText } from '@civitai/shared/rated-entity-sql';
import { storylineTextScanSubject } from '~/server/services/text-scan/profiles/storyline.profile';
import { textScanTextHash } from '~/server/services/text-scan/prompt';
import {
  approveAppealOfLift,
  liftScanTakedown as liftScanTakedownWrite,
  notifyStorylineTitleModerated,
} from '~/server/services/text-scan/actions/storyline';
import { scanEntityInBackground } from '~/server/services/text-scan/submit';
import { getStorylineImageCaptions } from '~/server/services/storyline-caption.service';
import { getLatestAppeal, resolveEntityAppeal } from '~/server/services/report.service';
import {
  DIRECT_LIFT_APPEAL_NOTE,
  DIRECT_LIFT_APPEAL_REASON,
  getStorylineAppealRefusal,
} from '~/shared/utils/appeal';
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
  STORYLINE_GRAPH_LIMIT,
  STORYLINE_MAX_COLLABORATORS,
  STORYLINE_MAX_CONTRIBUTORS,
  STORYLINE_PATH_LIMIT,
  compareStorylineChildren,
  getStorylineChapterRank,
  getStorylineChapterTombstone,
  isStorylineCeilingLevel,
  STORYLINE_MINOR_CEILING,
  storylineCeiling,
  storylineLevelAllowed,
  storylineShareMinChoices,
  toStorylineForkShares,
} from '~/shared/utils/storyline';
import type { StorylineStatus, StorylineWhoCanContinue } from '~/shared/utils/prisma/enums';
import { AppealStatus, EntityType, ReportStatus } from '~/shared/utils/prisma/enums';
import {
  isAnswerableParentChapter,
  STORYLINE_REFUSALS,
  storylineAboveRatingRefusal,
} from '~/shared/utils/storyline-placement';
import { createStorylineLinkJudge, STORYLINE_LINK_REFUSALS } from '~/shared/utils/storyline-graph';
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
  minorByScan: true,
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

/** The title's rating, as the text scan or a moderator set it. */
const storylineTitleLevelSelect = {
  nsfwLevel: true,
  moderatorNsfwLevel: true,
} satisfies Prisma.StorylineSelect;

/** What the read paths need to decide whether the storyline is hidden from a viewer. */
const storylineReadSelect = {
  ...storylineSelect,
  ...storylineTitleLevelSelect,
  user: { select: { id: true, username: true, bannedAt: true, deletedAt: true } },
  // The first chapter's level is the story's level for the reader's browsing-level gate.
  chapters: {
    where: { depth: 0 },
    select: { id: true, postId: true, post: { select: { nsfwLevel: true } } },
  },
} satisfies Prisma.StorylineSelect;

/** An invited collaborator has no say until they accept. */
const acceptedCollaboratorWhere = {
  acceptedAt: { not: null },
} satisfies Prisma.StorylineCollaboratorWhereInput;
const acceptedCollaboratorSql = (alias: string) =>
  Prisma.sql`${Prisma.raw(alias)}."acceptedAt" IS NOT NULL`;

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
 * Logs a write by anyone but the owner, which `getOwnedStoryline` admits only for a moderator.
 * Called after the write commits, so a failed log must not report the edit as failed.
 */
async function trackStorylineModEdit({
  storylineId,
  ownerId,
  userId,
  activity,
}: {
  storylineId: number;
  ownerId: number;
  userId: number;
  activity: StorylineModActivity['activity'];
}) {
  if (userId === ownerId) return;
  try {
    await trackModActivity(userId, { entityType: 'storyline', entityId: storylineId, activity });
  } catch (error) {
    logToAxiom({
      name: 'storyline-mod-activity',
      type: 'error',
      message: 'moderator storyline edit not logged',
      storylineId,
      activity,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
  }
}

/**
 * `chapters` is the storyline's chapter-1 row, if any. A storyline started before its first post
 * has none until that post is published, and until then it is its owner's draft.
 */
function isStorylineHidden(
  storyline: {
    userId: number;
    tosViolation: boolean;
    user: { bannedAt: Date | null; deletedAt: Date | null };
    chapters: unknown[];
  },
  viewer: Viewer,
  blockedUserIds: ReadonlySet<number>
) {
  if (viewer?.isModerator) return false;
  if (viewer?.id === storyline.userId) return false;
  return (
    !storyline.chapters.length ||
    storyline.tosViolation ||
    !!storyline.user.bannedAt ||
    !!storyline.user.deletedAt ||
    blockedUserIds.has(storyline.userId)
  );
}

/**
 * Users whose work this viewer does not see: either side of a block, and anyone the viewer has
 * hidden.
 */
async function getViewerExcludedIds(viewer: Viewer): Promise<ReadonlySet<number>> {
  if (!viewer) return new Set();
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
 * it is served. The story is judged by its first chapter's level (its ceiling when that chapter
 * is gone or unrated), raised to its title's rating.
 */
function isStorylineOutsideLevel(
  storyline: {
    userId: number;
    maxNsfwLevel: number;
    nsfwLevel: number;
    moderatorNsfwLevel: number | null;
    chapters: { post: { nsfwLevel: number } | null }[];
  },
  viewer: Viewer,
  browsingLevel: number
) {
  if (viewer?.isModerator || viewer?.id === storyline.userId) return false;
  const storyLevel = raiseNsfwLevel(
    storyline.chapters[0]?.post?.nsfwLevel || storyline.maxNsfwLevel,
    storyline.moderatorNsfwLevel ?? storyline.nsfwLevel
  );
  return outsideBrowsingLevel(storyLevel, browsingLevel);
}

/**
 * `raiseNsfwLevelText` in TypeScript: the flags of `level` at or above `floor`, or `floor` when it
 * has none. A post's level is a mask of its images' levels, so a larger number is not enough: PG
 * and X images together would still match a PG reader.
 */
function raiseNsfwLevel(level: number, floor: number) {
  if (!level || !floor) return level;
  return level & ~(floor - 1) || floor;
}

/** The SQL twin of the level `isStorylineOutsideLevel` judges, for the feed query. */
const storyLevelSql = Prisma.sql`(SELECT ${Prisma.raw(raiseNsfwLevelText('lv.l', 'lv.f'))}
  FROM (SELECT COALESCE(NULLIF(rp."nsfwLevel", 0), st."maxNsfwLevel") AS l,
    COALESCE(st."moderatorNsfwLevel", st."nsfwLevel") AS f) lv)`;

/** `storylineCeiling` in SQL, for a storyline aliased `st`. */
export const storylineCeilingSql = Prisma.sql`(CASE WHEN st."minorByScan" THEN LEAST(st."maxNsfwLevel", ${STORYLINE_MINOR_CEILING}) ELSE st."maxNsfwLevel" END)`;

/** What the refusals and the readiness check read off a continuation post. */
export const continuationPostSelect = {
  userId: true,
  publishedAt: true,
  nsfwLevel: true,
  tosViolation: true,
  storylineChapter: { select: { id: true } },
  images: {
    select: { ingestion: true, tosViolation: true, minor: true, poi: true, needsReview: true },
  },
} satisfies Prisma.PostSelect;

type ContinuationPost = Prisma.PostGetPayload<{ select: typeof continuationPostSelect }>;

/**
 * Where a continuation post stands.
 *
 * `doomed` is a moderation verdict on the post or any image in it and never
 * passes by waiting. `pending` is a state that resolves on its own: not
 * published, scheduled for later, an image still scanning, or no rating yet.
 * `inReview` is a scanned image a moderator has to look at.
 */
export function continuationReadiness(
  post: Pick<ContinuationPost, 'publishedAt' | 'nsfwLevel' | 'tosViolation' | 'images'>,
  now = new Date()
): 'doomed' | 'pending' | 'inReview' | 'ready' {
  if (
    post.tosViolation ||
    post.images.some(
      (image) => image.tosViolation || image.minor || image.poi || image.ingestion === 'Blocked'
    )
  )
    return 'doomed';
  if (
    !post.publishedAt ||
    post.publishedAt > now ||
    !post.images.length ||
    post.images.some((image) => image.ingestion !== 'Scanned') ||
    !post.nsfwLevel
  )
    return 'pending';
  if (post.images.some((image) => image.needsReview != null)) return 'inReview';
  return 'ready';
}

/**
 * Shared by every path that adds a chapter, so the rules cannot drift between them.
 */
export async function assertPostCanBeChapter(
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
  if (post.tosViolation) throw throwBadRequestError(STORYLINE_REFUSALS.cannotSubmit);
  if (!post.publishedAt || post.publishedAt > new Date())
    throw throwBadRequestError('Publish the post before adding it to a storyline');
  if (post.storylineChapter) throw throwBadRequestError('This post is already in a storyline');
  if (!post.nsfwLevel)
    throw throwBadRequestError('This post has not been rated yet. Try again once it has been');
  if (!storylineLevelAllowed({ postLevel: post.nsfwLevel, maxNsfwLevel }))
    throw throwBadRequestError(
      storylineAboveRatingRefusal({ postLevel: post.nsfwLevel, maxNsfwLevel })
    );
}

/**
 * Locks a parent chapter's row for the rest of the transaction, so two writers deciding its canon
 * child take turns instead of both choosing canon and one failing on the one-canon index.
 * NO KEY UPDATE, so it does not hold up other chapters being added under the same parent.
 */
const lockParentChapter = (db: Db, parentChapterId: number) =>
  db.$queryRaw`SELECT id FROM "StorylineChapter" WHERE id = ${parentChapterId} FOR NO KEY UPDATE`;

/** Also locks the parent (see `lockParentChapter`); true when it has no canon child yet. */
async function takesCanonSlot(db: Db, parentChapterId: number) {
  await lockParentChapter(db, parentChapterId);
  const existingCanon = await db.storylineChapterEdge.findFirst({
    where: { parentChapterId, canon: true },
    select: { chapterId: true },
  });
  return !existingCanon;
}

/**
 * Shares the storyline's row lock for the rest of the transaction. `insertStorylineChapter` holds
 * it exclusively while it moves chapters down, so a chapter added beside it reads its parent's
 * depth from before the insert or after it, never in between. Taken before any chapter lock, the
 * order the insert takes them in, so the two cannot deadlock.
 */
const lockStorylineForAdd = (db: Db, storylineId: number) =>
  db.$queryRaw`SELECT id FROM "Storyline" WHERE id = ${storylineId} FOR SHARE`;

/**
 * Inserts a chapter under a parent, canon when the storyline's owner wrote it and the parent has
 * no canon child yet. Edges point at the parent CHAPTER, never its post, so a later takedown of
 * the parent's post leaves this chapter attached.
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
    parent: { id: number; storylineId: number };
    ownerId: number;
    postId: number;
    authorId: number;
    placementId?: number;
  }
) {
  await lockStorylineForAdd(db, parent.storylineId);
  await lockParentChapter(db, parent.id);
  // Read again under the locks: what the caller read may be from before an insert moved the
  // parent down, a removal, or a takedown.
  const locked = await db.storylineChapter.findUnique({
    where: { id: parent.id },
    select: { depth: true, removedAt: true, storyline: { select: { tosViolation: true } } },
  });
  if (!locked) throw throwNotFoundError('Chapter not found');
  if (locked.storyline.tosViolation) throw throwBadRequestError('This storyline was taken down');
  if (locked.removedAt) throw throwBadRequestError('A removed chapter cannot be continued');

  const chapter = await db.storylineChapter.create({
    data: {
      storylineId: parent.storylineId,
      postId,
      userId: authorId,
      depth: locked.depth + 1,
      placementId,
    },
    select: { id: true },
  });

  const canon = authorId === ownerId && (await takesCanonSlot(db, parent.id));

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
 * Called inside the transaction that flips a storyline placement to approved (`settlePlacement`'s
 * `inTransaction`); a refusal throws a 400 and rolls the approval back. Postgres only, through
 * `db`.
 *
 * Idempotent on `placementId`: a replay returns the chapter the first call wrote, with
 * `created: false`.
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
    maxNsfwLevel: storylineCeiling(parent.storyline),
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
 * submission and for `writeChapterEdgeForPlacement` at approval; throws a 400 otherwise.
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
        select: {
          userId: true,
          maxNsfwLevel: true,
          minorByScan: true,
          tosViolation: true,
          whoCanContinue: true,
        },
      },
    },
  });
  if (!parent || !isAnswerableParentChapter(parent))
    throw throwBadRequestError(STORYLINE_REFUSALS.notAChapter);

  const ownerId = parent.storyline.userId;
  const [ownerBlocked, authorBlocked, collaborator] = await Promise.all([
    isBlockedPair(db, ownerId, placerId),
    isBlockedPair(db, parent.userId, placerId),
    db.storylineCollaborator.findUnique({
      where: { storylineId_userId: { storylineId: parent.storylineId, userId: placerId } },
      select: { acceptedAt: true },
    }),
  ]);
  if (ownerBlocked || authorBlocked)
    throw throwBadRequestError('Continuations are not available on this chapter');

  const isOwner = placerId === ownerId;
  const isCollaborator = !isOwner && !!collaborator?.acceptedAt;
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

export const isUniqueViolation = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';

/**
 * Links a post draft, as `post.create` writes it, to the storyline it was started from: chapter 1
 * of the author's own storyline (`storylineId` alone), or a continuation of `parentChapterId`
 * (`storylineId`, if sent, must be that chapter's). Called inside the post's transaction, after the
 * post row is written. No chapter is written here: that waits for the post to be published.
 */
export async function linkPendingChapter(
  db: Prisma.TransactionClient,
  {
    postId,
    userId,
    storylineId,
    parentChapterId,
  }: { postId: number; userId: number; storylineId?: number; parentChapterId?: number }
) {
  let linkedStorylineId: number;
  if (parentChapterId) {
    const parent = await db.storylineChapter.findUnique({
      where: { id: parentChapterId },
      select: { storylineId: true, postId: true },
    });
    if (!parent || parent.postId == null)
      throw throwBadRequestError(STORYLINE_REFUSALS.notAChapter);
    if (storylineId && storylineId !== parent.storylineId)
      throw throwBadRequestError('That chapter is not in this storyline');
    await assertCanContinueStoryline({ parentPostId: parent.postId, placerId: userId }, db);
    linkedStorylineId = parent.storylineId;
  } else {
    if (!storylineId) throw throwBadRequestError('Name the storyline this post starts');
    // Waits out a `setFirstChapter`, so its chapter 1 is seen below rather than orphaning this draft.
    await db.$queryRaw`SELECT 1 FROM "Storyline" WHERE id = ${storylineId} FOR SHARE`;
    const storyline = await db.storyline.findUnique({
      where: { id: storylineId },
      select: {
        userId: true,
        tosViolation: true,
        chapters: { where: { depth: 0 }, select: { id: true } },
      },
    });
    if (!storyline) throw throwNotFoundError('Storyline not found');
    if (storyline.userId !== userId)
      throw throwAuthorizationError("Only the storyline's creator can write its first chapter");
    if (storyline.tosViolation) throw throwBadRequestError('This storyline was taken down');
    if (storyline.chapters.length)
      throw throwBadRequestError('This storyline already has its first chapter');
    linkedStorylineId = storylineId;
  }

  try {
    await db.storylinePendingChapter.create({
      data: {
        postId,
        storylineId: linkedStorylineId,
        parentChapterId: parentChapterId ?? null,
        userId,
      },
    });
  } catch (error) {
    // The partial unique index: one chapter-1 draft per storyline.
    if (isUniqueViolation(error))
      throw throwBadRequestError('This storyline already has a draft of its first chapter');
    throw error;
  }
}

/**
 * The storyline a post draft was started from, for the post editor: null when the post has no
 * link, or the viewer is neither its author nor a moderator. From the primary, since the editor
 * reads it straight after the first upload creates the draft.
 */
export async function getPendingChapterForPost({
  postId,
  userId,
  isModerator,
}: {
  postId: number;
  userId: number;
  isModerator?: boolean;
}) {
  const link = await dbWrite.storylinePendingChapter.findUnique({
    where: { postId },
    select: {
      postId: true,
      userId: true,
      parentChapterId: true,
      storyline: { select: { ...storylineSelect } },
      // Ids only: the parent's post is read through the reading path, which tombstones it for
      // this viewer where it must.
      parentChapter: { select: { id: true, depth: true, postId: true } },
    },
  });
  if (!link || (link.userId !== userId && !isModerator)) return null;
  const { minorByScan, tosViolation, ...storyline } = link.storyline;
  return {
    postId: link.postId,
    storyline: {
      ...storyline,
      // The ceiling the chapter is held to, as readers get it; never the minor finding itself.
      maxNsfwLevel: storylineCeiling({ maxNsfwLevel: storyline.maxNsfwLevel, minorByScan }),
      takenDown: tosViolation,
    },
    // Null for chapter 1. `depth` is the parent's first-parent depth; on a route that reaches the
    // parent another way its number can differ (see `onRoute`).
    parentChapter: link.parentChapter,
  };
}

/**
 * Unlinks a draft from the storyline it was started from; the post stays an ordinary draft. Only
 * its author, and only while unpublished: once published, the link is publish's to resolve.
 */
export async function removePendingChapter({ postId, userId }: { postId: number; userId: number }) {
  const link = await dbWrite.storylinePendingChapter.findUnique({
    where: { postId },
    select: { userId: true, post: { select: { userId: true, publishedAt: true } } },
  });
  if (!link) return { removed: false };
  if (link.userId !== userId || link.post.userId !== userId)
    throw throwAuthorizationError('Only the author of this draft can remove it from the storyline');
  if (link.post.publishedAt) throw throwBadRequestError('This post is already published');
  // Conditional, so a publish that lands between the read and here keeps its link.
  const { count } = await dbWrite.storylinePendingChapter.deleteMany({
    where: { postId, userId, post: { userId, publishedAt: null } },
  });
  return { removed: count > 0 };
}

/** Chapter 1's row, once `assertPostCanBeChapter` has passed the post. */
export const createRootChapter = (
  db: Db,
  { storylineId, postId, userId }: { storylineId: number; postId: number; userId: number }
) =>
  db.storylineChapter.create({
    data: { storylineId, postId, userId, depth: 0 },
    select: { id: true },
  });

/**
 * Without `postId` the storyline starts empty: its chapter 1 is a post written afterwards (see
 * `linkPendingChapter`), and until that is written only its owner and moderators see it.
 */
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
  postId?: number;
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

  let created: { id: number; rootChapterId: number | null };
  try {
    created = await dbWrite.$transaction(async (tx) => {
      if (postId) await assertPostCanBeChapter(tx, { postId, authorId: userId, maxNsfwLevel });
      const storyline = await tx.storyline.create({
        data: { userId, title, maxNsfwLevel, whoCanContinue },
        select: { id: true },
      });
      const root = postId
        ? await createRootChapter(tx, { storylineId: storyline.id, postId, userId })
        : null;
      // Checked once chapter 1 exists, by the same rule as later picks: at this point that means
      // an image of the post the storyline starts from, and with no post any pick is refused.
      const picks = { coverImageId, heroImageId, heroImagePosition };
      if (coverImageId || heroImageId || heroImagePosition !== undefined) {
        await assertStorylinePicks(tx, {
          storylineId: storyline.id,
          ownerId: userId,
          callerId: userId,
          maxNsfwLevel,
          imageIds: [coverImageId, heroImageId],
        });
        await tx.storyline.update({ where: { id: storyline.id }, data: picks });
      }
      return { id: storyline.id, rootChapterId: root?.id ?? null };
    });
  } catch (error) {
    // Two requests starting a storyline from the same post: the loser hits the unique postId.
    if (isUniqueViolation(error)) throw throwBadRequestError('This post is already in a storyline');
    throw error;
  }
  scanEntityInBackground({ entityType: 'Storyline', entityId: created.id });
  return created;
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
  coverUpload,
  heroUpload,
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
  /** A file the caller just uploaded, made an image of theirs and picked. */
  coverUpload?: ImageInput;
  heroUpload?: ImageInput;
  userId: number;
  isModerator?: boolean;
}) {
  const current = await getOwnedStoryline({ storylineId: id, userId, isModerator });
  // An upload is a file the caller just put up, so its key is behind no image yet.
  for (const upload of [coverUpload, heroUpload])
    if (
      upload &&
      (await dbWrite.image.findFirst({ where: { url: upload.url }, select: { id: true } }))
    )
      throw new TRPCError({ code: 'BAD_REQUEST', message: COVER_IMAGE_UNAVAILABLE_MESSAGE });
  if (coverUpload) coverImageId = await resolveCoverImageId({ coverImage: coverUpload, userId });
  if (heroUpload) heroImageId = await resolveCoverImageId({ coverImage: heroUpload, userId });
  const uploadedIds = [coverUpload && coverImageId, heroUpload && heroImageId].filter(
    (imageId): imageId is number => !!imageId
  );
  if (maxNsfwLevel !== undefined) {
    if (!isStorylineCeilingLevel(maxNsfwLevel))
      throw throwBadRequestError('Invalid maximum rating');
    if (maxNsfwLevel < current.maxNsfwLevel) await assertCeilingKeepsFirstChapter(id, maxNsfwLevel);
  }
  if (title !== undefined)
    await throwOnBlockedUserContent(title, { isModerator, surface: 'storyline' });
  // A chapter image is held to the owner's rule, whoever picks it; an upload must be the picker's
  // own. A pick sent back unchanged is not judged again, so the picker can resend the whole form after a
  // collaborator whose image it is has been removed.
  await assertStorylinePicks(dbWrite, {
    storylineId: id,
    ownerId: current.userId,
    callerId: userId,
    uploadedIds,
    maxNsfwLevel: storylineCeiling({
      maxNsfwLevel: maxNsfwLevel ?? current.maxNsfwLevel,
      minorByScan: current.minorByScan,
    }),
    imageIds: [
      coverImageId !== current.coverImageId ? coverImageId : undefined,
      heroImageId !== current.heroImageId ? heroImageId : undefined,
    ],
  });

  // Lowering the ceiling hides later chapters above it at read time; nothing is deleted, so
  // raising it again brings them back.
  // Closing a Complete storyline to continuations is left to the placement layer reading the
  // status, so there is no second switch here to disagree with it.
  const [, updated] = await dbWrite.$transaction([
    // What lets the read path use an image in no post as this storyline's pick.
    dbWrite.storylineCoverUpload.createMany({
      data: uploadedIds.map((imageId) => ({ storylineId: id, imageId })),
      skipDuplicates: true,
    }),
    dbWrite.storyline.update({
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
    }),
  ]);
  // An edited title is how an owner has a title verdict looked at again.
  if (title !== undefined && title !== current.title)
    scanEntityInBackground({ entityType: 'Storyline', entityId: id });
  await trackStorylineModEdit({
    storylineId: id,
    ownerId: current.userId,
    userId,
    activity: 'update',
  });
  return updated;
}

/**
 * Whether deleting storyline `id` would delete anything of a held account: its owner's, or a
 * comment its cascade takes. The `commentId` arm reaches threads the cascade does not delete, so it
 * can only refuse more than needed.
 */
function storylineHeldSql({
  id,
  ownerId,
  markerView,
}: {
  id: number;
  ownerId: number;
  markerView: boolean;
}) {
  return Prisma.sql`(${ownerHeldSql(Prisma.sql`${ownerId}::int`)} OR EXISTS (
    WITH RECURSIVE below AS (
      SELECT t.id FROM "Thread" t WHERE t."storylineId" = ${id}
      UNION
      -- One indexed lookup per link: an OR across them scans the whole Thread table every step.
      SELECT x.id FROM below b CROSS JOIN LATERAL (
        SELECT t.id FROM "Thread" t WHERE t."parentThreadId" = b.id
        UNION ALL
        SELECT t.id FROM "Thread" t WHERE t."rootThreadId" = b.id
        UNION ALL
        SELECT t.id FROM "CommentV2" k JOIN "Thread" t ON t."commentId" = k.id
        WHERE k."threadId" = b.id
      ) x
    ),
    authors AS MATERIALIZED (
      SELECT r."userId" FROM "CommentV2" r JOIN below b ON r."threadId" = b.id
      UNION
      SELECT c."userId" FROM "CommentV3" c
      WHERE c."entityType" = 'storyline' AND c."entityId" = ${id}
    )
    SELECT 1 FROM authors a WHERE ${accountHoldSql(Prisma.sql`a."userId"`, markerView)}
  ))`;
}

export const STORYLINE_DELETE_REFUSALS = {
  /** Every reason an owner may not delete, in one text, so no one reason can be told apart. */
  owner:
    "You can't delete this storyline yourself. A moderator can delete it for you; contact support.",
  appealOpen: 'This storyline has an open appeal. Rule on it before deleting',
  paidContinuations:
    "This storyline has paid continuations that haven't settled yet. Try again once they have",
} as const;

/**
 * Deletes a storyline for its owner or a moderator. Its posts stay as they are: the chapter rows
 * that tie them to the storyline go with it (by cascade, as do its edges, branch choices, create
 * clicks, collaborators and comment thread), and a chapter-1 draft is unlinked and stays a draft.
 *
 * Refused while any paid continuation on it is pending or its Buzz has not finished moving, so no
 * escrow is left pointing at a chapter that no longer exists. A taken-down storyline is kept for
 * moderation: its owner cannot delete it, and a moderator cannot while the owner's appeal is open.
 */
export async function deleteStoryline({
  id,
  userId,
  isModerator,
}: {
  id: number;
  userId: number;
  isModerator?: boolean;
}) {
  // Read outside the transaction, as `bulkDeleteComments` does: what `accountHoldSql` needs.
  const markerView = await holdMarkerViewExists();
  await dbWrite.$transaction(async (tx) => {
    // Ownership first, unlocked (the owner never changes), so no one else's call takes a lock.
    const [owned] = await tx.$queryRaw<{ userId: number }[]>`
      SELECT "userId" FROM "Storyline" WHERE id = ${id}
    `;
    if (!owned) throw throwNotFoundError('Storyline not found');
    const asModerator = owned.userId !== userId;
    if (asModerator && !isModerator)
      throw throwAuthorizationError('Only the owner can delete this storyline');
    // Drafts before the storyline, the order `promotePendingChapter` locks them in: the cascade
    // below would otherwise deadlock against a chapter-1 draft going live.
    await tx.$queryRaw`SELECT 1 FROM "StorylinePendingChapter" WHERE "storylineId" = ${id} FOR UPDATE`;
    // FOR UPDATE waits out and then blocks every chapter writer and continuation submit: adds and
    // submits share this row (`lockStorylineForAdd`, `createStorylinePlacement`), inserts and
    // moves hold it NO KEY, and a chapter-1 insert's foreign key takes KEY SHARE. Whatever
    // committed first, the reads below see it.
    const [storyline] = await tx.$queryRaw<{ tosViolation: boolean }[]>`
      SELECT "tosViolation" FROM "Storyline" WHERE id = ${id} FOR UPDATE
    `;
    if (!storyline) throw throwNotFoundError('Storyline not found');
    if (storyline.tosViolation) {
      // The owner never, moderator or not: the takedown is against them.
      if (!asModerator) throw throwBadRequestError(STORYLINE_DELETE_REFUSALS.owner);
      const [{ appealOpen }] = await tx.$queryRaw<{ appealOpen: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM "Appeal"
          WHERE "entityType" = ${EntityType.Storyline}::"EntityType" AND "entityId" = ${id}
            AND status = ${AppealStatus.Pending}::"AppealStatus" AND "entityRemovedAt" IS NULL
        ) AS "appealOpen"
      `;
      if (appealOpen) throw throwBadRequestError(STORYLINE_DELETE_REFUSALS.appealOpen);
    }
    // A paid continuation targets a chapter's post, and an approved one is its chapter's
    // placement.
    const [{ unsettled, approved }] = await tx.$queryRaw<
      { unsettled: boolean; approved: boolean }[]
    >`
      WITH paid AS (
        SELECT p.id, p.status FROM "Placement" p
        WHERE p.surface = 'storyline' AND NOT p.free AND p.amount > 0
          AND (
            (p."targetType" = 'post' AND p."targetId" IN (
              SELECT "postId" FROM "StorylineChapter" WHERE "storylineId" = ${id} AND "postId" IS NOT NULL
            ))
            OR p.id IN (
              SELECT "placementId" FROM "StorylineChapter" WHERE "storylineId" = ${id} AND "placementId" IS NOT NULL
            )
          )
      )
      SELECT EXISTS (SELECT 1 FROM paid WHERE status = 'approved') AS approved, EXISTS (
        SELECT 1 FROM paid p WHERE ${placementMoneyInFlightSql(Prisma.raw('p'))}
      ) AS unsettled
    `;
    if (unsettled) throw throwBadRequestError(STORYLINE_DELETE_REFUSALS.paidContinuations);
    const held = storylineHeldSql({ id, ownerId: owned.userId, markerView });
    const holdRefusal = () =>
      asModerator ? contentKeptError(true) : throwBadRequestError(STORYLINE_DELETE_REFUSALS.owner);
    const [{ isHeld }] = await tx.$queryRaw<{ isHeld: boolean }[]>`SELECT ${held} AS "isHeld"`;
    if (isHeld) throw holdRefusal();
    // An owner paid for approved continuations cannot then delete the chapters they were paid for
    // (a refunded one does not count), nor delete what is under report. A moderator can.
    if (!asModerator) {
      if (approved) throw throwBadRequestError(STORYLINE_DELETE_REFUSALS.owner);
      const [{ reported }] = await tx.$queryRaw<{ reported: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM "StorylineReport" sr JOIN "Report" r ON r.id = sr."reportId"
          WHERE sr."storylineId" = ${id}
            AND r.status IN (${ReportStatus.Pending}::"ReportStatus", ${ReportStatus.Processing}::"ReportStatus")
        ) AS reported
      `;
      if (reported) throw throwBadRequestError(STORYLINE_DELETE_REFUSALS.owner);
    }
    // No foreign key: the owner's continuation price for this storyline would outlive it.
    await tx.$executeRaw`
      DELETE FROM "PlacementSpace"
      WHERE surface = 'storyline' AND "entityType" = 'storyline' AND "entityId" = ${id}
    `;
    // A moderator's delete answers the open reports on it, which would otherwise sit in the queue
    // with nothing to point at once the cascade takes their links.
    if (asModerator)
      await tx.$executeRaw`
        UPDATE "Report" r SET status = ${ReportStatus.Actioned}::"ReportStatus"
        FROM "StorylineReport" sr
        WHERE sr."reportId" = r.id AND sr."storylineId" = ${id}
          AND r.status IN (${ReportStatus.Pending}::"ReportStatus", ${ReportStatus.Processing}::"ReportStatus")
      `;
    // The hold is in the DELETE itself too, so one placed after the check above still stops it.
    const deleted = await tx.$executeRaw`DELETE FROM "Storyline" WHERE id = ${id} AND NOT ${held}`;
    if (!deleted) throw holdRefusal();
    // In the transaction, unlike `trackStorylineModEdit`: nothing else records what was deleted.
    if (asModerator)
      await trackModActivity(
        userId,
        { entityType: 'storyline', entityId: id, activity: 'delete' },
        tx
      );
  });
  return { id };
}

export const STORYLINE_CHAPTER_REMOVE_REFUSALS = {
  firstChapter: "Chapter 1 can't be removed. Delete the storyline instead",
  hasChildren: 'Other chapters continue from this one, so it cannot be removed',
  waiting: 'This chapter has a continuation waiting for review; answer it first',
  paidContinuation: "This chapter's payment hasn't settled yet. Try again once it has",
  /** A taken-down storyline, and (for its owner) a chapter someone paid to add. */
  moderatorOnly:
    "You can't remove this chapter yourself. A moderator can remove it for you; contact support",
  removed: 'This chapter was already removed',
} as const;

/**
 * Takes a chapter out of its storyline for the storyline's owner, the chapter's author or a
 * moderator. The post is not touched. Only a chapter nothing continues from can go, so no other
 * chapter loses its way in. The owner's or author's removal deletes the row, with its edges and
 * reader choices; a moderator's tombstones it, as a placement takedown does, so the row keeps
 * holding its post and it cannot be submitted again. The placement that added it, if any, is
 * marked removed; no Buzz moves, as with a moderator's takedown.
 */
export async function removeStorylineChapter({
  chapterId,
  userId,
  isModerator,
}: {
  chapterId: number;
  userId: number;
  isModerator?: boolean;
}) {
  const result = await dbWrite.$transaction(async (tx) => {
    const [found] = await tx.$queryRaw<
      { storylineId: number; ownerId: number; authorId: number }[]
    >`
      SELECT c."storylineId", s."userId" AS "ownerId", c."userId" AS "authorId"
      FROM "StorylineChapter" c JOIN "Storyline" s ON s.id = c."storylineId"
      WHERE c.id = ${chapterId}
    `;
    if (!found) throw throwNotFoundError('Chapter not found');
    const { storylineId, ownerId } = found;
    // Before any lock, so a stranger cannot hold up the storyline; checked again under the locks.
    if (userId !== ownerId && userId !== found.authorId && !isModerator)
      throw throwAuthorizationError();
    // Exclusive against adds, submits, links and moves (`moveStorylineChapter`'s lock). A submit
    // blocked here still lands on a moderator's tombstone, as on a takedown's, and is refunded by
    // the orphaned-continuation job.
    const [storyline] = await tx.$queryRaw<{ tosViolation: boolean; title: string }[]>`
      SELECT "tosViolation", title FROM "Storyline" WHERE id = ${storylineId} FOR NO KEY UPDATE
    `;
    if (!storyline) throw throwNotFoundError('Chapter not found');
    // The placement before the chapter, the order a placement takedown (`takeDownApproved`) locks
    // them in. `placementId` never changes once written.
    const [unlocked] = await tx.$queryRaw<{ placementId: number | null }[]>`
      SELECT "placementId" FROM "StorylineChapter" WHERE id = ${chapterId}
    `;
    const [placement] =
      unlocked?.placementId != null
        ? await tx.$queryRaw<{ status: string; paid: boolean; inFlight: boolean }[]>`
            SELECT p.status, (NOT p.free AND p.amount > 0) AS paid,
              ${placementMoneyInFlightSql(Prisma.raw('p'))} AS "inFlight"
            FROM "Placement" p WHERE p.id = ${unlocked.placementId} FOR UPDATE
          `
        : [];
    const [chapter] = await tx.$queryRaw<
      {
        userId: number;
        depth: number;
        postId: number | null;
        placementId: number | null;
        removedAt: Date | null;
        createdAt: Date;
      }[]
    >`
      SELECT "userId", depth, "postId", "placementId", "removedAt", "createdAt" FROM "StorylineChapter"
      WHERE id = ${chapterId} AND "storylineId" = ${storylineId} FOR UPDATE
    `;
    if (!chapter) throw throwNotFoundError('Chapter not found');

    const role =
      userId === ownerId
        ? 'owner'
        : userId === chapter.userId
        ? 'author'
        : isModerator
        ? 'moderator'
        : null;
    if (!role) throw throwAuthorizationError();
    if (storyline.tosViolation && role !== 'moderator')
      throw throwBadRequestError(STORYLINE_CHAPTER_REMOVE_REFUSALS.moderatorOnly);
    if (chapter.depth === 0)
      throw throwBadRequestError(STORYLINE_CHAPTER_REMOVE_REFUSALS.firstChapter);
    // Deleting a tombstone would free its post to be submitted again.
    if (chapter.removedAt) throw throwBadRequestError(STORYLINE_CHAPTER_REMOVE_REFUSALS.removed);

    const [{ hasChildren, waiting }] = await tx.$queryRaw<
      { hasChildren: boolean; waiting: boolean }[]
    >`
      SELECT
        EXISTS (SELECT 1 FROM "StorylineChapterEdge" WHERE "parentChapterId" = ${chapterId})
          AS "hasChildren",
        (
          EXISTS (
            SELECT 1 FROM "Placement" pl
            WHERE pl.surface = 'storyline' AND pl."targetType" = 'post'
              AND pl."targetId" = ${chapter.postId} AND pl.status = 'pending'
          )
          OR EXISTS (SELECT 1 FROM "StorylinePendingChapter" WHERE "parentChapterId" = ${chapterId})
        ) AS waiting
    `;
    if (hasChildren) throw throwBadRequestError(STORYLINE_CHAPTER_REMOVE_REFUSALS.hasChildren);
    if (waiting) throw throwBadRequestError(STORYLINE_CHAPTER_REMOVE_REFUSALS.waiting);
    if (placement?.inFlight)
      throw throwBadRequestError(STORYLINE_CHAPTER_REMOVE_REFUSALS.paidContinuation);
    // An owner's or author's removal during an open report is recorded for moderators.
    const openReportIds =
      role === 'moderator'
        ? []
        : (
            await tx.$queryRaw<{ id: number }[]>`
              SELECT r.id FROM "PostReport" pr JOIN "Report" r ON r.id = pr."reportId"
              WHERE pr."postId" = ${chapter.postId}
                AND r.status IN (${ReportStatus.Pending}::"ReportStatus", ${ReportStatus.Processing}::"ReportStatus")
              UNION
              SELECT r.id FROM "StorylineReport" sr JOIN "Report" r ON r.id = sr."reportId"
              WHERE sr."storylineId" = ${storylineId}
                AND r.status IN (${ReportStatus.Pending}::"ReportStatus", ${ReportStatus.Processing}::"ReportStatus")
            `
          ).map((r) => r.id);

    if (chapter.placementId != null) {
      // The contributor paid the owner to add it; the owner cannot take it back out for free.
      if (placement?.paid && role === 'owner')
        throw throwBadRequestError(STORYLINE_CHAPTER_REMOVE_REFUSALS.moderatorOnly);
      if (placement?.status === 'approved')
        await tx.$executeRaw`
          UPDATE "Placement"
          SET status = 'removed', "removedBy" = ${role === 'author' ? 'placer' : role},
            "takenDownAt" = now(), "takenDownById" = ${userId}
          WHERE id = ${chapter.placementId} AND status = 'approved'
        `;
    }

    const parents = await tx.$queryRaw<{ parentChapterId: number }[]>`
      SELECT "parentChapterId" FROM "StorylineChapterEdge" WHERE "chapterId" = ${chapterId}
    `;
    if (role === 'moderator')
      await tx.$executeRaw`UPDATE "StorylineChapter" SET "removedAt" = now() WHERE id = ${chapterId}`;
    else {
      // Every owner's or author's removal is the same hard delete. When either must be kept for
      // records, this same statement copies the chapter and the rows its delete cascades to, so the
      // decision is made at the write. The row is locked, so no child row can join it meanwhile.
      const kept = Prisma.sql`(${ownerHeldSql(Prisma.sql`${ownerId}::int`)} OR ${ownerHeldSql(
        Prisma.sql`${chapter.userId}::int`
      )})`;
      const ids = Prisma.sql`${ownerId}::int, ${chapter.userId}::int`;
      await tx.$executeRaw`
        WITH kept AS (SELECT ${kept} AS kept),
        chapter AS (
          INSERT INTO "HeldStorylineChapter" (id, "storylineId", "postId", "userId", depth,
            "placementId", "createdAt", "removedAt", "ownerId", "authorId")
          SELECT id, "storylineId", "postId", "userId", depth, "placementId", "createdAt",
            "removedAt", ${ids}
          FROM "StorylineChapter" WHERE id = ${chapterId} AND (SELECT kept FROM kept) IS NOT FALSE
        ),
        edges AS (
          INSERT INTO "HeldStorylineChapterEdge" ("storylineId", "chapterId", "parentChapterId",
            canon, "createdAt", "ownerId", "authorId")
          SELECT "storylineId", "chapterId", "parentChapterId", canon, "createdAt", ${ids}
          FROM "StorylineChapterEdge"
          WHERE "chapterId" = ${chapterId} AND (SELECT kept FROM kept) IS NOT FALSE
        ),
        choices AS (
          INSERT INTO "HeldStorylineBranchChoice" ("userId", "parentChapterId", "chapterId",
            "createdAt", "updatedAt", "ownerId", "authorId")
          SELECT "userId", "parentChapterId", "chapterId", "createdAt", "updatedAt", ${ids}
          FROM "StorylineBranchChoice"
          WHERE ("chapterId" = ${chapterId} OR "parentChapterId" = ${chapterId}) AND (SELECT kept FROM kept) IS NOT FALSE
        ),
        clicks AS (
          INSERT INTO "HeldStorylineCreateClick" ("userId", "parentChapterId", "createdAt",
            "ownerId", "authorId")
          SELECT "userId", "parentChapterId", "createdAt", ${ids}
          FROM "StorylineCreateClick"
          WHERE "parentChapterId" = ${chapterId} AND (SELECT kept FROM kept) IS NOT FALSE
        )
        DELETE FROM "StorylineChapter" WHERE id = ${chapterId}
      `;
    }
    if (openReportIds.length)
      await tx.$executeRaw`
        INSERT INTO "StorylineChapterRemovalHold" ("storylineId", "storylineTitle", "chapterId",
          "postId", "chapterUserId", depth, "placementId", "parentChapterIds", "chapterCreatedAt",
          "removedById", "removedByRole", "reportIds")
        VALUES (${storylineId}, ${storyline.title}, ${chapterId}, ${chapter.postId}, ${
        chapter.userId
      }, ${chapter.depth},
          ${chapter.placementId}, ${parents.map((p) => p.parentChapterId)}::int[],
          ${chapter.createdAt}, ${userId}, ${role}, ${openReportIds}::int[])
      `;
    if (role === 'moderator')
      await trackModActivity(
        userId,
        { entityType: 'storyline', entityId: storylineId, activity: 'removeChapter' },
        tx
      );
    return { storylineId, parentIds: parents.map((p) => p.parentChapterId) };
  });

  // Committed; stale counts until the entries expire beat reporting the removal as failed.
  await Promise.all(
    result.parentIds.map((id) => bustFetchThroughCache(forkCountsKey(id)).catch(() => undefined))
  );
  return { storylineId: result.storylineId, chapterId };
}

/**
 * Makes a post its owner has already published chapter 1 of their empty storyline. The post is
 * held to `createStoryline`'s rules and, like a chapter-1 draft going live (`promotePendingChapter`),
 * must be scanned and out of review, and raises the ceiling to fit it.
 */
export async function setFirstChapter({
  storylineId,
  postId,
  userId,
}: {
  storylineId: number;
  postId: number;
  userId: number;
}) {
  try {
    return await dbWrite.$transaction(async (tx) => {
      const [owned] = await tx.$queryRaw<{ userId: number }[]>`
        SELECT "userId" FROM "Storyline" WHERE id = ${storylineId}
      `;
      if (!owned) throw throwNotFoundError('Storyline not found');
      if (owned.userId !== userId)
        throw throwAuthorizationError("Only the storyline's creator can choose its first chapter");
      // `deleteStoryline`'s order, drafts then the storyline. NO KEY UPDATE rather than an add's
      // SHARE: the ceiling update below would otherwise have two of these deadlock upgrading.
      await tx.$queryRaw`
        SELECT 1 FROM "StorylinePendingChapter" WHERE "storylineId" = ${storylineId} FOR UPDATE
      `;
      const [storyline] = await tx.$queryRaw<
        { maxNsfwLevel: number; minorByScan: boolean; tosViolation: boolean }[]
      >`
        SELECT "maxNsfwLevel", "minorByScan", "tosViolation" FROM "Storyline"
        WHERE id = ${storylineId}
        FOR NO KEY UPDATE
      `;
      if (!storyline) throw throwNotFoundError('Storyline not found');
      if (storyline.tosViolation) throw throwBadRequestError('This storyline was taken down');
      // Read after the storyline lock, which `linkPendingChapter` waits on: a draft linked while
      // this waited is seen here, not missed by the draft lock above.
      const [{ hasChapter, hasDraft }] = await tx.$queryRaw<
        { hasChapter: boolean; hasDraft: boolean }[]
      >`
        SELECT
          EXISTS (SELECT 1 FROM "StorylineChapter" WHERE "storylineId" = ${storylineId}) AS "hasChapter",
          EXISTS (
            SELECT 1 FROM "StorylinePendingChapter"
            WHERE "storylineId" = ${storylineId} AND "parentChapterId" IS NULL
          ) AS "hasDraft"
      `;
      if (hasChapter) throw throwBadRequestError('This storyline already has its first chapter');
      if (hasDraft)
        throw throwBadRequestError('This storyline already has a draft of its first chapter');

      const post = await tx.post.findUnique({
        where: { id: postId },
        select: continuationPostSelect,
      });
      // Nothing fits: judged at the current ceiling, so the refusal is the usual one.
      const maxNsfwLevel =
        (post && firstChapterMaxNsfwLevel(storyline, post)) ?? storyline.maxNsfwLevel;
      await assertPostCanBeChapter(tx, {
        postId,
        authorId: userId,
        maxNsfwLevel: storylineCeiling({ ...storyline, maxNsfwLevel }),
      });
      // Its rating may still change while an image is scanning or in review.
      const readiness = post ? continuationReadiness(post) : 'doomed';
      if (readiness === 'doomed') throw throwBadRequestError(STORYLINE_REFUSALS.cannotSubmit);
      if (readiness !== 'ready')
        throw throwBadRequestError(
          "This post's images are still being checked. Try again once they are"
        );
      const raised = maxNsfwLevel !== storyline.maxNsfwLevel;
      if (raised) await tx.storyline.update({ where: { id: storylineId }, data: { maxNsfwLevel } });
      const { id: chapterId } = await createRootChapter(tx, { storylineId, postId, userId });
      return { storylineId, chapterId, ceilingRaisedTo: raised ? maxNsfwLevel : undefined };
    });
  } catch (error) {
    // Chapter 1 is held by the locks above, so this is the post joining another storyline
    // between its check and the insert.
    if (isUniqueViolation(error)) throw throwBadRequestError('This post is already in a storyline');
    throw error;
  }
}

/**
 * A moderator's ruling on a storyline's title. `moderatorNsfwLevel` stands in for the scan's
 * rating (null hands it back to the scan). `liftScanTakedown` lifts a takedown the title scan
 * made, for the title the moderator reviewed, and records that text so a scan of it, a redelivered
 * verdict included, does not take it down again. Refused if the title has changed since: the new
 * one was never reviewed. A moderator's own takedown is not lifted here, and keeps it down.
 *
 * A lift that leaves the storyline up also approves the owner's open appeal of the takedown, marked
 * as a direct lift (`DIRECT_LIFT_APPEAL_REASON`) rather than a reviewed appeal. While a moderator's
 * takedown still holds, the appeal stays open: approving it would say the story is back up.
 * `leaveAppealOpen` is for a caller that rules on that appeal itself.
 */
export async function moderateStorylineTitle({
  id,
  moderatorNsfwLevel,
  liftScanTakedown,
  moderatorId,
}: {
  id: number;
  moderatorNsfwLevel?: number | null;
  liftScanTakedown?: { reviewedTitle: string; leaveAppealOpen?: boolean };
  moderatorId?: number;
}) {
  if (moderatorNsfwLevel != null && !isStorylineCeilingLevel(moderatorNsfwLevel))
    throw throwBadRequestError('Invalid rating');
  const storyline = await dbWrite.storyline.findUnique({
    where: { id },
    select: { tosViolationByScan: true, title: true, userId: true },
  });
  if (!storyline) throw throwNotFoundError('Storyline not found');
  if (liftScanTakedown && !storyline.tosViolationByScan)
    throw throwBadRequestError('This storyline was not taken down by its title scan');
  if (liftScanTakedown && storyline.title !== liftScanTakedown.reviewedTitle)
    throw throwBadRequestError('The title has changed since it was reviewed');

  // The hash of the reviewed text itself, not a fresh read: the title could change and change
  // back between a read and the update below, which only checks the text at the end. Conditional
  // on the flag still being the scan's and the title the reviewed one, so neither a takedown nor
  // an edit made in between is waved through. A moderator's takedown, if any, stays.
  const count = liftScanTakedown
    ? await liftScanTakedownWrite(id, {
        where: { title: liftScanTakedown.reviewedTitle },
        data: {
          moderatorNsfwLevel,
          scanFlagLiftedTextHash: textScanTextHash(
            storylineTextScanSubject({
              userId: storyline.userId,
              title: liftScanTakedown.reviewedTitle,
            })
          ),
        },
      })
    : (await dbWrite.storyline.updateMany({ where: { id }, data: { moderatorNsfwLevel } })).count;
  if (!count) throw throwBadRequestError('The storyline changed since it was reviewed');
  // The takedown the scan would make with this rating, marked as the scan's so a lift for the
  // title can end it. Not for text a moderator has cleared (the scan's own rule), which includes a
  // lift in this same call.
  if (moderatorNsfwLevel != null && moderatorNsfwLevel >= NsfwLevel.R) {
    const currentText = textScanTextHash(
      storylineTextScanSubject({ userId: storyline.userId, title: storyline.title })
    );
    const { count: takenDown } = await dbWrite.storyline.updateMany({
      where: {
        id,
        title: storyline.title,
        minorByScan: true,
        tosViolationByScan: false,
        OR: [{ scanFlagLiftedTextHash: null }, { scanFlagLiftedTextHash: { not: currentText } }],
      },
      data: { tosViolation: true, tosViolationByScan: true },
    });
    if (takenDown)
      await notifyStorylineTitleModerated(
        storyline,
        { storylineId: id, takenDown: true },
        `moderator-${Date.now()}`
      );
  }
  const result = await dbWrite.storyline.findUniqueOrThrow({
    where: { id },
    select: { id: true, ...storylineTakedownSelect, ...storylineTitleLevelSelect },
  });
  if (liftScanTakedown && !liftScanTakedown.leaveAppealOpen && !result.tosViolation)
    await approveAppealOfLift(id, {
      resolvedReason: DIRECT_LIFT_APPEAL_REASON,
      internalNotes: DIRECT_LIFT_APPEAL_NOTE,
      userId: moderatorId,
    });
  return result;
}

const storylineTakedownSelect = {
  tosViolation: true,
  tosViolationByScan: true,
  tosViolationByModerator: true,
} satisfies Prisma.StorylineSelect;

/**
 * A moderator takes a storyline down, or restores one they took down. Their takedown is held
 * apart from the title scan's, so a clean rescan cannot lift it and a restore cannot lift the
 * scan's: the storyline stays down while the scan holds one. `changed` is false when there was
 * nothing to do (already down, or no moderator takedown to restore).
 */
export async function setStorylineTakedown({ id, takenDown }: { id: number; takenDown: boolean }) {
  const changed = takenDown
    ? (
        await dbWrite.storyline.updateMany({
          where: { id, tosViolationByModerator: false },
          data: { tosViolation: true, tosViolationByModerator: true },
        })
      ).count
    : (
        await Promise.all([
          dbWrite.storyline.updateMany({
            where: { id, tosViolationByModerator: true, tosViolationByScan: false },
            data: { tosViolation: false, tosViolationByModerator: false },
          }),
          dbWrite.storyline.updateMany({
            where: { id, tosViolationByModerator: true, tosViolationByScan: true },
            data: { tosViolationByModerator: false },
          }),
        ])
      ).reduce((sum, { count }) => sum + count, 0);
  const storyline = await dbWrite.storyline.findUnique({
    where: { id },
    select: { id: true, ...storylineTakedownSelect },
  });
  if (!storyline) throw throwNotFoundError('Storyline not found');
  return { ...storyline, changed: changed > 0 };
}

/**
 * Rules on the owner's appeal of a title-scan takedown. A grant lifts it for `reviewedTitle`, the
 * title the moderator saw; a title edited since is refused and the appeal stays open. A grant is
 * refused while a moderator's takedown holds (it would leave the storyline down), and a denial
 * while nothing holds one (it would tell the owner a takedown stands that does not).
 */
export async function resolveStorylineTitleAppeal({
  id,
  grant,
  reviewedTitle,
  userId,
}: {
  id: number;
  grant: boolean;
  reviewedTitle: string;
  userId: number;
}) {
  const appeal = await dbWrite.appeal.findFirst({
    where: {
      entityType: EntityType.Storyline,
      entityId: id,
      status: AppealStatus.Pending,
      entityRemovedAt: null,
    },
    select: { id: true },
  });
  if (!appeal) throw throwBadRequestError('This storyline has no open appeal');
  const storyline = await dbWrite.storyline.findUnique({
    where: { id },
    select: { ...storylineTakedownSelect },
  });
  if (!storyline) throw throwNotFoundError('Storyline not found');
  if (grant && storyline.tosViolationByModerator)
    throw throwBadRequestError(
      'A moderator took this storyline down too. Restore that first to grant the appeal'
    );
  if (!grant && !storyline.tosViolationByScan && !storyline.tosViolationByModerator)
    throw throwBadRequestError('This storyline is no longer taken down');
  // With nothing left to lift (an edited title rescanned clean, or a lift elsewhere), a grant only
  // closes the appeal.
  const lifted = grant && storyline.tosViolationByScan;
  if (lifted)
    await moderateStorylineTitle({
      id,
      liftScanTakedown: { reviewedTitle, leaveAppealOpen: true },
    });

  const closed = await resolveEntityAppeal({
    ids: [id],
    entityType: EntityType.Storyline,
    status: grant ? AppealStatus.Approved : AppealStatus.Rejected,
    userId,
  });
  if (!closed.length)
    throw throwBadRequestError(
      lifted
        ? 'The takedown was lifted, but another moderator had already ruled on this appeal'
        : 'Another moderator ruled on this appeal first'
    );
  return { granted: grant };
}

export const STORYLINE_PICK_REFUSALS = {
  notAllowed:
    "Choose an image from your own chapters, an endorsed collaborator's, or one you upload",
  cannotUse: 'This image cannot be used as a cover or banner',
  unrated: 'This image has not been rated yet. Try again once it has been',
} as const;

/**
 * The cover and banner may only be an image from this storyline's chapters, written by its owner
 * or an endorsed collaborator (the endorsement is their consent) and not removed, or one the caller
 * uploaded. A chapter image must also be rated within the ceiling; an upload is taken whatever its
 * scan says and judged when read. Anything else is refused, whatever the client offered.
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
    callerId,
    uploadedIds = [],
    maxNsfwLevel,
    imageIds,
  }: {
    storylineId: number;
    ownerId: number;
    /** Who is picking: an image they uploaded (in no post) is theirs to use. */
    callerId: number;
    /** Images this request uploaded. The only images in no post a pick may be. */
    uploadedIds?: number[];
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
        userId: true,
        postId: true,
        ingestion: true,
        tosViolation: true,
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
    db.storylineCollaborator.findMany({
      where: { storylineId, ...acceptedCollaboratorWhere },
      select: { userId: true },
    }),
  ]);
  const allowedAuthors = new Set([ownerId, ...collaborators.map((c) => c.userId)]);
  const byId = new Map(images.map((image) => [image.id, image]));
  for (const imageId of ids) {
    const image = byId.get(imageId);
    const chapter = image?.post?.storylineChapter;
    const fromChapter =
      !!chapter &&
      chapter.storylineId === storylineId &&
      !chapter.removedAt &&
      allowedAuthors.has(chapter.userId);
    const uploaded =
      !!image &&
      image.postId == null &&
      image.userId === callerId &&
      uploadedIds.includes(image.id);
    if (!image || (!fromChapter && !uploaded))
      throw throwBadRequestError(STORYLINE_PICK_REFUSALS.notAllowed);
    // The caller's own upload is taken whatever its scan says: a refusal here would tell them the
    // verdict. The read gate shows it only once the scan has cleared and rated it, within the
    // ceiling, and the owner sees the same note for any pick that is not showing.
    if (uploaded) continue;
    // Never shown as a cover or banner (see storylineImageVisible), so refused rather than kept.
    if (
      image.minor ||
      image.poi ||
      image.tosViolation ||
      image.ingestion === 'Blocked' ||
      image.ingestion === 'Error' ||
      image.ingestion === 'NotFound'
    )
      throw throwBadRequestError(STORYLINE_PICK_REFUSALS.cannotUse);
    if (!image.nsfwLevel) throw throwBadRequestError(STORYLINE_PICK_REFUSALS.unrated);
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
export function firstChapterFloor(
  post: { nsfwLevel: number; tosViolation: boolean } | null | undefined
) {
  if (!post || post.tosViolation || !post.nsfwLevel) return null;
  const highest = getHighestBrowsingLevelBit(post.nsfwLevel);
  return highest === NsfwLevel.Blocked ? null : highest;
}

/**
 * The owner's ceiling for a storyline about to get `post` as chapter 1: unchanged when the post
 * fits, raised to the post's rating when it does not, or null when no ceiling fits it (unrated,
 * Blocked, or held to safe for work by a minor-flagged title). The owner picked the ceiling before
 * choosing chapter 1, so chapter 1 sets it rather than being refused by it.
 */
export function firstChapterMaxNsfwLevel(
  storyline: { maxNsfwLevel: number; minorByScan: boolean },
  post: { nsfwLevel: number; tosViolation: boolean }
) {
  const fits = (maxNsfwLevel: number) =>
    storylineLevelAllowed({
      postLevel: post.nsfwLevel,
      maxNsfwLevel: storylineCeiling({ ...storyline, maxNsfwLevel }),
    });
  if (fits(storyline.maxNsfwLevel)) return storyline.maxNsfwLevel;
  const needed = firstChapterFloor(post);
  return needed !== null && isStorylineCeilingLevel(needed) && fits(needed) ? needed : null;
}

/** The owner continuing their own story directly; everyone else continues through a placement. */
export async function addOwnerChapter(input: {
  parentChapterId: number;
  postId: number;
  userId: number;
}) {
  return dbWrite.$transaction((tx) => writeOwnerChapter(tx, input));
}

/**
 * The owner adds a post at the end of the main path: chapter 1 of an empty storyline, else the
 * canon child of the main path's last chapter. Found here, under the storyline's lock and with no
 * path cap, not by the client: a stale or capped read would add it as a side branch instead.
 */
export async function addOwnerChapterAtEnd({
  storylineId,
  postId,
  userId,
}: {
  storylineId: number;
  postId: number;
  userId: number;
}) {
  const [root] = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT id FROM "StorylineChapter" WHERE "storylineId" = ${storylineId} AND depth = 0
  `;
  if (!root) return setFirstChapter({ storylineId, postId, userId });

  return dbWrite.$transaction(async (tx) => {
    await lockStorylineForAdd(tx, storylineId);
    // One canon child per parent; the step cap only guards against a cycle.
    const [end] = await tx.$queryRaw<{ id: number }[]>`
      WITH RECURSIVE main AS (
        SELECT ${root.id}::int AS id, 1 AS step
        UNION ALL
        SELECT e."chapterId", main.step + 1 FROM main
        JOIN "StorylineChapterEdge" e ON e."parentChapterId" = main.id AND e.canon
        WHERE main.step < 100000
      )
      SELECT id FROM main ORDER BY step DESC LIMIT 1
    `;
    const { chapterId } = await writeOwnerChapter(tx, {
      parentChapterId: end.id,
      postId,
      userId,
    });
    const [canon] = await tx.$queryRaw<{ canon: boolean }[]>`
      SELECT canon FROM "StorylineChapterEdge" WHERE "chapterId" = ${chapterId}
    `;
    if (!canon?.canon) throw throwBadRequestError('The storyline changed while adding. Try again');
    return { storylineId, chapterId };
  });
}

/** `addOwnerChapter` inside the caller's transaction. */
export async function writeOwnerChapter(
  tx: Prisma.TransactionClient,
  { parentChapterId, postId, userId }: { parentChapterId: number; postId: number; userId: number }
) {
  const parent = await tx.storylineChapter.findUnique({
    where: { id: parentChapterId },
    select: {
      id: true,
      storylineId: true,
      depth: true,
      removedAt: true,
      storyline: {
        select: { userId: true, maxNsfwLevel: true, minorByScan: true, tosViolation: true },
      },
    },
  });
  if (!parent) throw throwNotFoundError('Chapter not found');
  if (parent.storyline.userId !== userId) throw throwAuthorizationError();
  if (parent.storyline.tosViolation) throw throwBadRequestError('This storyline was taken down');
  if (parent.removedAt) throw throwBadRequestError('A removed chapter cannot be continued');

  await assertPostCanBeChapter(tx, {
    postId,
    authorId: userId,
    maxNsfwLevel: storylineCeiling(parent.storyline),
  });
  const chapterId = await insertChildChapter(tx, {
    parent,
    ownerId: parent.storyline.userId,
    postId,
    authorId: userId,
  });
  return { chapterId };
}

/**
 * Makes one child the owner's main route out of its parent, replacing the previous one. A chapter
 * with several parents needs `parentChapterId` to say which parent's route it becomes.
 */
export async function setCanonChapter({
  chapterId,
  parentChapterId,
  userId,
  isModerator,
}: {
  chapterId: number;
  parentChapterId?: number;
  userId: number;
  isModerator?: boolean;
}) {
  const edges = await dbWrite.storylineChapterEdge.findMany({
    where: { chapterId, parentChapterId },
    select: {
      parentChapterId: true,
      storylineId: true,
      chapter: { select: { removedAt: true } },
    },
    take: 2,
  });
  const [edge] = edges;
  if (!edge)
    throw throwBadRequestError(
      parentChapterId
        ? 'That chapter does not continue from this one'
        : 'The first chapter is always the main route'
    );
  if (edges.length > 1)
    throw throwBadRequestError('This chapter continues several chapters: choose which one');
  const { userId: ownerId } = await getOwnedStoryline({
    storylineId: edge.storylineId,
    userId,
    isModerator,
  });
  if (edge.chapter.removedAt)
    throw throwBadRequestError('A removed chapter cannot be the main route');

  await dbWrite.$transaction(async (tx) => {
    await lockParentChapter(tx, edge.parentChapterId);
    await tx.storylineChapterEdge.updateMany({
      where: { parentChapterId: edge.parentChapterId, canon: true },
      data: { canon: false },
    });
    const { count } = await tx.storylineChapterEdge.updateMany({
      where: { chapterId, parentChapterId: edge.parentChapterId },
      data: { canon: true },
    });
    // An insert can have moved the edge since it was read; rolls back the line above with it.
    if (!count) throw throwBadRequestError('That chapter no longer follows this one');
  });
  await trackStorylineModEdit({
    storylineId: edge.storylineId,
    ownerId,
    userId,
    activity: 'setCanon',
  });
}

const storylineEdges = (db: Db | typeof dbRead, storylineId: number) =>
  db.storylineChapterEdge.findMany({
    where: { storylineId },
    select: { chapterId: true, parentChapterId: true },
  });

/**
 * Takes the share lock on the live chapters among `ids`, held to the end of the transaction, and
 * says which they are. A removal's update of one waits for it, and one that has already committed
 * is not among them, so what is joined is live from here to the commit. In id order, so two
 * writers locking the same chapters ask for them in the same order.
 */
export const lockLiveChapters = async (db: Db, ids: number[]) =>
  (
    await db.$queryRaw<{ id: number }[]>`
      SELECT id FROM "StorylineChapter"
      WHERE id = ANY(${ids}::int[]) AND "removedAt" IS NULL
      ORDER BY id
      FOR SHARE
    `
  ).map((row) => row.id);

/**
 * Whether a chapter may be joined: the storyline's owner is shown it. The owner's view, not the
 * one of whoever is asking, so a moderator choosing for them is offered, and refused, exactly what
 * the owner would be. The picker and the link both ask this, so they cannot disagree.
 */
async function createChapterJoinable(storyline: {
  userId: number;
  maxNsfwLevel: number;
  minorByScan: boolean;
}) {
  const viewer = { id: storyline.userId };
  const blockedUserIds = await getViewerExcludedIds(viewer);
  const maxNsfwLevel = storylineCeiling(storyline);
  return (chapter: {
    removedAt: Date | null;
    post: Parameters<typeof getStorylineChapterTombstone>[0]['post'];
  }) =>
    getStorylineChapterTombstone({
      post: chapter.post,
      removed: !!chapter.removedAt,
      viewer,
      maxNsfwLevel,
      browsingLevel: allBrowsingLevelsFlag,
      blockedUserIds,
    }) === null;
}

/**
 * The owner (or a moderator) offers an existing chapter as a way on from `parentChapterId`, so
 * two branches rejoin at it. The chapter gains a parent and keeps its depth.
 */
export async function linkStorylineChapter({
  parentChapterId,
  chapterId,
  userId,
  isModerator,
}: {
  parentChapterId: number;
  chapterId: number;
  userId: number;
  isModerator?: boolean;
}) {
  if (parentChapterId === chapterId) throw throwBadRequestError('A chapter cannot continue itself');
  const parent = await dbWrite.storylineChapter.findUnique({
    where: { id: parentChapterId },
    select: { storylineId: true },
  });
  if (!parent) throw throwNotFoundError('Chapter not found');
  const { storylineId } = parent;
  const { userId: ownerId } = await getOwnedStoryline({ storylineId, userId, isModerator });

  try {
    await dbWrite.$transaction(async (tx) => {
      // The whole storyline, not the parent: two links judged at once could each pass the loop
      // check alone and make a loop together.
      await tx.$queryRaw`SELECT id FROM "Storyline" WHERE id = ${storylineId} FOR NO KEY UPDATE`;
      const storyline = await tx.storyline.findUnique({
        where: { id: storylineId },
        select: { tosViolation: true, userId: true, maxNsfwLevel: true, minorByScan: true },
      });
      if (storyline?.tosViolation) throw throwBadRequestError('This storyline was taken down');
      // Before the reads below, so what they find stays true until the edge is written.
      const live = await lockLiveChapters(tx, [parentChapterId, chapterId]);
      const chapters = await tx.storylineChapter.findMany({
        where: { id: { in: [parentChapterId, chapterId] }, storylineId },
        select: { id: true, depth: true, removedAt: true, post: { select: chapterPostSelect } },
      });
      const target = chapters.find((c) => c.id === chapterId);
      if (chapters.length < 2 || !target || !storyline)
        throw throwNotFoundError('Chapter not found');
      if (live.length < 2 || chapters.some((c) => c.removedAt))
        throw throwBadRequestError('A removed chapter cannot be joined');
      if (target.depth === 0)
        throw throwBadRequestError('The first chapter cannot continue another chapter');
      if (!(await createChapterJoinable(storyline))(target))
        throw throwBadRequestError('That chapter cannot be joined');
      const judge = createStorylineLinkJudge(
        await storylineEdges(tx, storylineId),
        parentChapterId
      );
      const refusal = judge(chapterId);
      if (refusal) throw throwBadRequestError(STORYLINE_LINK_REFUSALS[refusal]);

      await tx.storylineChapterEdge.create({
        data: {
          storylineId,
          chapterId,
          parentChapterId,
          canon: await takesCanonSlot(tx, parentChapterId),
        },
      });
    });
  } catch (error) {
    // Until the rejoin migration is applied, the old one-parent index refuses a second parent.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      throw throwBadRequestError('Joining chapters is not available yet');
    throw error;
  }
  await trackStorylineModEdit({ storylineId, ownerId, userId, activity: 'linkChapter' });
}

type InsertEdgeRow = {
  canon: boolean;
  firstParent: boolean;
  parentDepth: number;
  parentRemovedAt: Date | null;
  childPlacementId: number | null;
  tosViolation: boolean;
  maxNsfwLevel: number;
  minorByScan: boolean;
};

/**
 * The owner (or a moderator for them) puts one of the owner's posts between a chapter and one way
 * on from it: the edge `parent → child` becomes `parent → new → child`. No chapter id changes, so
 * links to either still resolve.
 */
export async function insertStorylineChapter({
  storylineId,
  parentChapterId,
  childChapterId,
  postId,
  userId,
  isModerator,
}: {
  storylineId: number;
  parentChapterId: number;
  childChapterId: number;
  postId: number;
  userId: number;
  isModerator?: boolean;
}) {
  const { userId: ownerId } = await getOwnedStoryline({ storylineId, userId, isModerator });

  const chapterId = await dbWrite.$transaction(async (tx) => {
    // The whole storyline, as `linkStorylineChapter` does: the depth shift below must not run
    // beside a link, another insert, or a chapter add (`lockStorylineForAdd`).
    await tx.$queryRaw`SELECT id FROM "Storyline" WHERE id = ${storylineId} FOR NO KEY UPDATE`;
    await tx.$queryRaw`
      SELECT id FROM "StorylineChapter"
      WHERE id = ${parentChapterId} AND "storylineId" = ${storylineId}
      FOR NO KEY UPDATE
    `;
    const [edge] = await tx.$queryRaw<InsertEdgeRow[]>`
      SELECT e.canon,
        e."parentChapterId" = (
          SELECT f."parentChapterId" FROM "StorylineChapterEdge" f
          WHERE f."chapterId" = e."chapterId"
          ORDER BY f."createdAt", f."parentChapterId"
          LIMIT 1
        ) AS "firstParent",
        p.depth AS "parentDepth", p."removedAt" AS "parentRemovedAt",
        c."placementId" AS "childPlacementId",
        st."tosViolation", st."maxNsfwLevel", st."minorByScan"
      FROM "StorylineChapterEdge" e
      JOIN "StorylineChapter" p ON p.id = e."parentChapterId"
      JOIN "StorylineChapter" c ON c.id = e."chapterId"
      JOIN "Storyline" st ON st.id = e."storylineId"
      WHERE e."storylineId" = ${storylineId}
        AND e."parentChapterId" = ${parentChapterId}
        AND e."chapterId" = ${childChapterId}
    `;
    if (!edge) throw throwBadRequestError('That chapter no longer follows this one');
    if (edge.tosViolation) throw throwBadRequestError('This storyline was taken down');
    if (edge.parentRemovedAt) throw throwBadRequestError('A removed chapter cannot be continued');
    // A contributor's placement names the chapter it continued, which would no longer be the one
    // before it. Through a later parent it is fine: the placement never named that one.
    if (edge.firstParent && edge.childPlacementId != null)
      throw throwBadRequestError("A chapter cannot be inserted before a contributor's chapter");

    await assertPostCanBeChapter(tx, {
      postId,
      authorId: ownerId,
      maxNsfwLevel: storylineCeiling(edge),
    });
    const { id } = await tx.storylineChapter
      .create({
        data: { storylineId, postId, userId: ownerId, depth: edge.parentDepth + 1 },
        select: { id: true },
      })
      .catch((error: unknown) => {
        // The post became a chapter elsewhere since it was checked.
        if (isUniqueViolation(error))
          throw throwBadRequestError('This post is already in a storyline');
        throw error;
      });
    // Moved, not recreated: its createdAt keeps the child's parent order, so a child whose first
    // parent was `parent` has the new chapter as its first parent. The new edge takes the same
    // createdAt, so the new chapter has the child's place among the parent's ways on.
    await tx.$executeRaw`
      UPDATE "StorylineChapterEdge" SET "parentChapterId" = ${id}, canon = true
      WHERE "parentChapterId" = ${parentChapterId} AND "chapterId" = ${childChapterId}
    `;
    await tx.$executeRaw`
      INSERT INTO "StorylineChapterEdge" ("storylineId", "chapterId", "parentChapterId", canon, "createdAt")
      SELECT "storylineId", ${id}, ${parentChapterId}, ${edge.canon}, "createdAt"
      FROM "StorylineChapterEdge"
      WHERE "parentChapterId" = ${id} AND "chapterId" = ${childChapterId}
    `;
    if (edge.firstParent)
      await tx.$executeRaw`
        WITH RECURSIVE below AS (
          SELECT ${childChapterId}::int AS id, ARRAY[${childChapterId}::int] AS seen
          UNION ALL
          SELECT e."chapterId", below.seen || e."chapterId"
          FROM below
          JOIN "StorylineChapterEdge" e ON e."parentChapterId" = below.id
          WHERE e."chapterId" <> ALL(below.seen)
            AND e."parentChapterId" = (
              SELECT f."parentChapterId" FROM "StorylineChapterEdge" f
              WHERE f."chapterId" = e."chapterId"
              ORDER BY f."createdAt", f."parentChapterId"
              LIMIT 1
            )
        )
        UPDATE "StorylineChapter" c SET depth = c.depth + 1
        FROM (SELECT DISTINCT id FROM below) b
        WHERE c.id = b.id
      `;
    // The primary key is (userId, parentChapterId), so moving the choice cannot collide.
    await tx.$executeRaw`
      UPDATE "StorylineBranchChoice" SET "chapterId" = ${id}
      WHERE "parentChapterId" = ${parentChapterId} AND "chapterId" = ${childChapterId}
    `;
    return id;
  });

  // The insert has committed; stale counts until the entry expires beat reporting it as failed.
  await bustFetchThroughCache(forkCountsKey(parentChapterId)).catch(() => undefined);
  await trackStorylineModEdit({ storylineId, ownerId, userId, activity: 'insertChapter' });
  return { chapterId };
}

const MOVE_REFUSAL = 'Only your own chapters in a single line can be moved';

/**
 * The owner (or a moderator for them) moves `chapterId` to sit straight after `afterChapterId`.
 * Only within one run of the owner's own chapters, each the single way on from the one before:
 * no fork, rejoin or contributor's chapter is moved past, so no placement's parent, no reader's
 * route through a fork and no rejoin's depth changes. Returns the run's chapter ids in their new
 * order. No chapter id changes, so links to any of them still resolve.
 */
export async function moveStorylineChapter({
  storylineId,
  chapterId,
  afterChapterId,
  userId,
  isModerator,
}: {
  storylineId: number;
  chapterId: number;
  afterChapterId: number;
  userId: number;
  isModerator?: boolean;
}) {
  if (chapterId === afterChapterId) throw throwBadRequestError('A chapter cannot follow itself');
  const { userId: ownerId } = await getOwnedStoryline({ storylineId, userId, isModerator });

  const result = await dbWrite.$transaction(async (tx) => {
    // Exclusive against links, inserts and other moves, and against adds (`lockStorylineForAdd`):
    // nothing else changes which chapter follows which until the commit.
    const [storyline] = await tx.$queryRaw<{ tosViolation: boolean; title: string }[]>`
      SELECT "tosViolation", title FROM "Storyline" WHERE id = ${storylineId} FOR NO KEY UPDATE
    `;
    if (!storyline) throw throwNotFoundError('Storyline not found');
    if (storyline.tosViolation) throw throwBadRequestError('This storyline was taken down');

    const chapters = await tx.$queryRaw<
      { id: number; depth: number; userId: number; placementId: number | null; removed: boolean }[]
    >`
      SELECT id, depth, "userId", "placementId", "removedAt" IS NOT NULL AS removed
      FROM "StorylineChapter" WHERE "storylineId" = ${storylineId}
    `;
    const edgeRows = await tx.$queryRaw<{ chapterId: number; parentChapterId: number }[]>`
      SELECT "chapterId", "parentChapterId" FROM "StorylineChapterEdge"
      WHERE "storylineId" = ${storylineId}
    `;
    const byId = new Map(chapters.map((c) => [c.id, c]));
    const moved = byId.get(chapterId);
    const after = byId.get(afterChapterId);
    if (!moved || !after) throw throwNotFoundError('Chapter not found');
    if (moved.depth === 0) throw throwBadRequestError('The first chapter cannot be moved');

    const parentsOf = new Map<number, number[]>();
    const childrenOf = new Map<number, number[]>();
    for (const e of edgeRows) {
      if (!parentsOf.has(e.chapterId)) parentsOf.set(e.chapterId, []);
      if (!childrenOf.has(e.parentChapterId)) childrenOf.set(e.parentChapterId, []);
      parentsOf.get(e.chapterId)?.push(e.parentChapterId);
      childrenOf.get(e.parentChapterId)?.push(e.chapterId);
    }
    const parents = (id: number) => parentsOf.get(id) ?? [];
    const children = (id: number) => childrenOf.get(id) ?? [];
    const isOwners = (id: number) => {
      const c = byId.get(id);
      // A removed chapter is neither moved nor moved past.
      return !!c && c.userId === ownerId && c.placementId == null && !c.removed;
    };
    // `next` is in the same run as `id`: the only way on from it, reached by no other way in.
    const linked = (id: number, next: number) =>
      isOwners(id) &&
      isOwners(next) &&
      children(id).length === 1 &&
      children(id)[0] === next &&
      parents(next).length === 1;

    let head = chapterId;
    const seen = new Set([head]);
    for (
      let p = parents(head)[0];
      p != null && linked(p, head) && !seen.has(p);
      p = parents(p)[0]
    ) {
      head = p;
      seen.add(p);
    }
    const run = [head];
    for (
      let c = children(head)[0];
      c != null && linked(run[run.length - 1], c) && !run.includes(c);
      c = children(c)[0]
    )
      run.push(c);
    const tail = run[run.length - 1];

    // A chapter at the end of the run takes or leaves its place only when nothing follows it: what
    // follows a tail is a fork, a rejoin or someone else's chapter, which must not move with it.
    const fitsAtEnd = (id: number) => id !== tail || children(id).length === 0;
    if (
      run[0] === chapterId ||
      !run.includes(afterChapterId) ||
      !fitsAtEnd(chapterId) ||
      !fitsAtEnd(afterChapterId) ||
      (after.depth !== 0 && parents(afterChapterId).length !== 1)
    )
      throw throwBadRequestError(MOVE_REFUSAL);

    const order = run.filter((id) => id !== chapterId);
    order.splice(order.indexOf(afterChapterId) + 1, 0, chapterId);
    const oldParent = run[run.indexOf(chapterId) - 1];
    if (oldParent === afterChapterId) return { chapterIds: run, changedParents: [] as number[] };

    const oldChild = run[run.indexOf(chapterId) + 1] as number | undefined;
    const afterChild = run[run.indexOf(afterChapterId) + 1] as number | undefined;
    // Each parent whose way on is rewired, locked as `setCanonChapter` locks a parent, so its canon
    // flag read below holds until the commit. In id order, as `lockLiveChapters` locks.
    const rewired = [oldParent, chapterId, afterChapterId].sort((a, b) => a - b);
    await tx.$queryRaw`
      SELECT id FROM "StorylineChapter" WHERE id = ANY(${rewired}::int[]) ORDER BY id FOR NO KEY UPDATE
    `;
    const outEdges = await tx.$queryRaw<
      { chapterId: number; parentChapterId: number; canon: boolean; createdAt: Date }[]
    >`
      SELECT "chapterId", "parentChapterId", canon, "createdAt" FROM "StorylineChapterEdge"
      WHERE "parentChapterId" = ANY(${rewired}::int[])
    `;
    // A continuation waiting on one of these was written to follow it where it stood: approved
    // after the move, it would land somewhere its author never saw (a paid "next chapter" at the
    // end becoming a fork early in the story).
    const [waiting] = await tx.$queryRaw<{ id: number }[]>`
      SELECT c.id FROM "StorylineChapter" c
      WHERE c.id = ANY(${rewired}::int[])
        AND (
          EXISTS (
            SELECT 1 FROM "Placement" pl
            WHERE pl.surface = 'storyline' AND pl."targetType" = 'post'
              AND pl."targetId" = c."postId" AND pl.status = 'pending'
          )
          OR EXISTS (SELECT 1 FROM "StorylinePendingChapter" d WHERE d."parentChapterId" = c.id)
        )
      LIMIT 1
    `;
    if (waiting)
      throw throwBadRequestError(
        'This chapter has a continuation waiting for review; answer it first'
      );

    const canonOutOf = (id: number) =>
      outEdges.find((e) => e.parentChapterId === id)?.canon ?? true;
    const afterEdge = outEdges.find((e) => e.parentChapterId === afterChapterId);

    // Each parent keeps the canon flag of its one way on, so the main route stays where the owner
    // put it. In this order so no parent has two canon children at any statement (one-canon index).
    await tx.$executeRaw`
      DELETE FROM "StorylineChapterEdge"
      WHERE "parentChapterId" = ${oldParent} AND "chapterId" = ${chapterId}
    `;
    if (oldChild != null)
      await tx.$executeRaw`
        UPDATE "StorylineChapterEdge" SET "parentChapterId" = ${oldParent}, canon = ${canonOutOf(
        oldParent
      )}
        WHERE "parentChapterId" = ${chapterId} AND "chapterId" = ${oldChild}
      `;
    if (afterChild != null)
      await tx.$executeRaw`
        UPDATE "StorylineChapterEdge" SET "parentChapterId" = ${chapterId}, canon = ${canonOutOf(
        chapterId
      )}
        WHERE "parentChapterId" = ${afterChapterId} AND "chapterId" = ${afterChild}
      `;
    await tx.$executeRaw`
      INSERT INTO "StorylineChapterEdge" ("storylineId", "chapterId", "parentChapterId", canon, "createdAt")
      VALUES (${storylineId}, ${chapterId}, ${afterChapterId}, ${canonOutOf(afterChapterId)},
        ${afterEdge?.createdAt ?? new Date()})
    `;

    // The run keeps its head and its length, so its last place keeps its depth, and so does
    // everything beyond it.
    const headDepth = byId.get(head)?.depth ?? 0;
    const depths = order.map((_, i) => headDepth + i);
    await tx.$executeRaw`
      UPDATE "StorylineChapter" c SET depth = v.depth
      FROM unnest(${order}::int[], ${depths}::int[]) AS v(id, depth)
      WHERE c.id = v.id AND c.depth <> v.depth
    `;

    // A reader's choice is recorded at any chapter, not only at a fork, so the three parents whose
    // one way on changed point their readers' choice at the new one, or drop it at the run's end.
    const changedParents = [oldParent, chapterId, afterChapterId];
    for (const parentId of changedParents) {
      const next = order[order.indexOf(parentId) + 1] as number | undefined;
      if (next != null)
        await tx.$executeRaw`
          UPDATE "StorylineBranchChoice" SET "chapterId" = ${next} WHERE "parentChapterId" = ${parentId}
        `;
      else
        await tx.$executeRaw`DELETE FROM "StorylineBranchChoice" WHERE "parentChapterId" = ${parentId}`;
    }
    return { chapterIds: order, changedParents };
  });

  // Committed; stale counts until the entries expire beat reporting the move as failed.
  await Promise.all(
    result.changedParents.map((id) =>
      bustFetchThroughCache(forkCountsKey(id)).catch(() => undefined)
    )
  );
  await trackStorylineModEdit({ storylineId, ownerId, userId, activity: 'moveChapter' });
  return { chapterIds: result.chapterIds };
}

const STORYLINE_LINK_TARGETS_LIMIT = 100;

/**
 * The chapters `linkStorylineChapter` would accept from `parentChapterId`, for the owner's picker:
 * the `STORYLINE_LINK_TARGETS_LIMIT` nearest the parent. Chapters the owner is shown a tombstone
 * for are left out.
 */
export async function getStorylineLinkTargets({
  parentChapterId,
  userId,
  isModerator,
}: {
  parentChapterId: number;
  userId: number;
  isModerator?: boolean;
}) {
  const parent = await dbRead.storylineChapter.findUnique({
    where: { id: parentChapterId },
    select: { storylineId: true, removedAt: true, depth: true },
  });
  if (!parent) throw throwNotFoundError('Chapter not found');
  if (parent.removedAt) throw throwBadRequestError('A removed chapter cannot be joined');
  const storyline = await getOwnedStoryline({
    storylineId: parent.storylineId,
    userId,
    isModerator,
  });
  const viewer = { id: userId, isModerator };
  const [chapters, edges, joinable, blockedUserIds] = await Promise.all([
    dbRead.storylineChapter.findMany({
      where: { storylineId: storyline.id, removedAt: null, depth: { gt: 0 } },
      select: { id: true, depth: true, removedAt: true, post: { select: chapterPostSelect } },
      orderBy: [{ depth: 'asc' }, { id: 'asc' }],
    }),
    storylineEdges(dbRead, storyline.id),
    createChapterJoinable(storyline),
    getViewerExcludedIds(viewer),
  ]);
  const judge = createStorylineLinkJudge(edges, parentChapterId);
  // The nearest to the parent first, ahead of it before behind: a rejoin is nearly always a few
  // chapters on, so the cap keeps those and not the shallowest. The judging stops at the cap.
  const nearest = chapters
    .filter((chapter) => chapter.id !== parentChapterId && joinable(chapter))
    .sort(
      (a, b) =>
        Math.abs(a.depth - parent.depth) - Math.abs(b.depth - parent.depth) ||
        b.depth - a.depth ||
        a.id - b.id
    );
  const accepted: typeof nearest = [];
  for (const chapter of nearest) {
    if (accepted.length === STORYLINE_LINK_TARGETS_LIMIT) break;
    if (!judge(chapter.id)) accepted.push(chapter);
  }
  const targets = accepted
    .sort((a, b) => a.depth - b.depth || a.id - b.id)
    .map((chapter) => toPathChapter(chapter, chapter.post, null));
  return withFirstImages(
    getStorylineImageGate(viewer, allBrowsingLevelsFlag, blockedUserIds),
    targets
  );
}

/**
 * The owner only, never a moderator: an endorsed collaborator's priced continuations are approved
 * without review, so endorsing is approving them in advance. It invites them: nothing changes for
 * them, and nobody sees them on the storyline, until they accept (`acceptStorylineInvite`).
 */
export async function addStorylineCollaborator({
  storylineId,
  targetUserId,
  userId,
}: {
  storylineId: number;
  targetUserId: number;
  userId: number;
}) {
  const storyline = await getOwnedStoryline({ storylineId, userId });
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
    create: { storylineId, userId: targetUserId, acceptedAt: null },
    update: {},
  });
}

const INVITE_CLOSED = 'That invitation is no longer open';

/**
 * The invitee accepts. Declining is `leave` (`removeStorylineCollaborator`), which a muted account
 * can still reach. A block between the two since the invitation, or a takedown, closes it.
 */
export async function acceptStorylineInvite({
  storylineId,
  userId,
}: {
  storylineId: number;
  userId: number;
}) {
  const storyline = await dbWrite.storyline.findUnique({
    where: { id: storylineId },
    select: { userId: true, tosViolation: true },
  });
  if (!storyline || storyline.tosViolation) throw throwNotFoundError(INVITE_CLOSED);
  if (await isBlockedPair(dbWrite, storyline.userId, userId)) {
    await dbWrite.storylineCollaborator.deleteMany({
      where: { storylineId, userId, acceptedAt: null },
    });
    throw throwNotFoundError(INVITE_CLOSED);
  }
  const { count } = await dbWrite.storylineCollaborator.updateMany({
    where: { storylineId, userId, acceptedAt: null },
    data: { acceptedAt: new Date() },
  });
  if (!count) throw throwNotFoundError(INVITE_CLOSED);
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
  const owned =
    targetUserId === userId ? null : await getOwnedStoryline({ storylineId, userId, isModerator });
  await dbWrite.storylineCollaborator.deleteMany({ where: { storylineId, userId: targetUserId } });
  if (owned)
    await trackStorylineModEdit({
      storylineId,
      ownerId: owned.userId,
      userId,
      activity: 'removeCollaborator',
    });
}

/**
 * A storyline's header. Not found when it is hidden from this viewer or outside their browsing
 * level (see `isStorylineOutsideLevel`): the title and cast belong to a story they could not
 * open.
 *
 * The storyline's discussion is the comment thread of its first chapter's post (`rootPostId`).
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
      tosViolationByScan: true,
      tosViolationByModerator: true,
      user: { select: castUserSelect },
      collaborators: {
        select: { acceptedAt: true, user: { select: castUserSelect } },
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
  const accepted = storyline.collaborators.filter((c) => c.acceptedAt);
  const collaborators = accepted
    .map((c) => c.user)
    .filter(shownUser)
    .map(toCastUser);
  const collaboratorIds = new Set(accepted.map((c) => c.user.id));
  const invitedIds = new Set(
    storyline.collaborators.filter((c) => !c.acceptedAt).map((c) => c.user.id)
  );
  const gate = getStorylineImageGate(viewer, browsingLevel, blockedUserIds);

  // A contributor is credited only through a chapter this reader would be shown: published,
  // rated, not taken down, within the story's ceiling and the reader's level. Otherwise the cast
  // list would name the author of a chapter the path shows as a tombstone.
  const ceilingMask = storylineCeiling(storyline) * 2 - 1;
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
          ceiling: storylineCeiling(storyline),
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
  const chapterCountById = new Map(
    [...authors, ...castCounts].map((row) => [row.userId, row.chapterCount])
  );
  const chaptersBy = (userId: number) => chapterCountById.get(userId) ?? 0;
  const titleAppealable = viewer?.id === storyline.userId && !getStorylineAppealRefusal(storyline);
  const titleAppeal =
    titleAppealable && viewer
      ? await getLatestAppeal({ entityType: EntityType.Storyline, entityId: id, userId: viewer.id })
      : null;

  const {
    tosViolationByScan: _tosViolationByScan,
    tosViolationByModerator: _tosViolationByModerator,
    chapters: _chapters,
    collaborators: _collaborators,
    user,
    coverImageId,
    heroImageId,
    minorByScan,
    // The title's ratings decide who is shown the story; readers get the decision, not them.
    nsfwLevel: _nsfwLevel,
    moderatorNsfwLevel: _moderatorNsfwLevel,
    ...rest
  } = storyline;
  const ownerUser = toCastUser(user);
  const isOwnerView = viewer?.id === storyline.userId || !!viewer?.isModerator;
  const firstChapter = mainPath[0]?.depth === 0 ? mainPath[0] : undefined;
  const banner = chosen(id, heroImageId);
  return {
    ...rest,
    user: ownerUser,
    // The ceiling chapters are held to, lowered while the title scan holds the storyline as about
    // a minor. The owner's own setting, for their settings form, is `ownerMaxNsfwLevel`.
    maxNsfwLevel: storylineCeiling({ maxNsfwLevel: rest.maxNsfwLevel, minorByScan }),
    ownerMaxNsfwLevel: isOwnerView ? rest.maxNsfwLevel : null,
    // A pick this reader may not see falls through to the next, never shown blurred.
    heroImage: banner ?? chosen(id, coverImageId) ?? firstChapter?.firstImage ?? null,
    // Whether heroImage is the banner pick, so the page shows it as a wide banner at its focus
    // rather than a portrait it must blur. Readers get no pick ids to compare.
    heroIsBanner: !!banner,
    coverImage: chosen(id, coverImageId) ?? firstChapter?.firstImage ?? null,
    coverImageId: isOwnerView ? coverImageId : null,
    heroImageId: isOwnerView ? heroImageId : null,
    // A pick that is not showing, usually an upload whose scan has not cleared it yet.
    coverPickHidden: isOwnerView && coverImageId != null && !chosen(id, coverImageId),
    heroPickHidden: isOwnerView && heroImageId != null && !banner,
    titleAppealable,
    titleAppeal,
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
    // Invitations not yet accepted: the owner's to see, and the invitee's to answer.
    pendingCollaborators: isOwnerView
      ? storyline.collaborators
          .filter((c) => !c.acceptedAt)
          .map((c) => c.user)
          .filter(shownUser)
          .map(toCastUser)
      : [],
    viewerInvited: !!viewer && invitedIds.has(viewer.id),
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

/** A route's row, with its parents oldest link first. */
type RouteRow = {
  id: number;
  postId: number | null;
  depth: number;
  removedAt: Date | null;
  parentIds: number[];
};

/** Where other branches join a route: each chapter's parents other than the chapter before it. */
async function getRouteJoins(
  rows: RouteRow[],
  tombstoneOf: (
    post: StorylineChapterPost | null,
    removed: boolean
  ) => StorylineTombstoneReason | null
) {
  const joinIds = new Map<number, number[]>();
  rows.forEach((row, i) => {
    const others = i > 0 ? row.parentIds.filter((id) => id !== rows[i - 1].id) : [];
    if (others.length) joinIds.set(row.id, others);
  });
  const joins = new Map<number, StorylinePathChapter[]>();
  const ids = [...new Set([...joinIds.values()].flat())];
  if (!ids.length) return joins;

  const parents = await dbRead.storylineChapter.findMany({
    where: { id: { in: ids } },
    select: { id: true, depth: true, removedAt: true, post: { select: chapterPostSelect } },
  });
  const byId = new Map(
    parents.map((p) => [p.id, toPathChapter(p, p.post, tombstoneOf(p.post, !!p.removedAt))])
  );
  for (const [id, parentIds] of joinIds)
    joins.set(
      id,
      parentIds.flatMap((parentId) => byId.get(parentId) ?? [])
    );
  return joins;
}

/**
 * A route's chapters with their numbers on it: `depth` counts from the route's first row, so a
 * chapter with several parents is numbered by the way the reader came, not by its first parent.
 */
const onRoute = <T extends { depth: number }>(rows: RouteRow[], chapters: T[]) =>
  chapters.map((chapter, i) => ({
    ...chapter,
    depth: (rows[0]?.depth ?? 0) + i,
    parentCount: rows[i].parentIds.length,
  }));

/**
 * The walk that defines a storyline's main route: from `rootChapterId`, each chapter's canon child
 * in turn, at most `STORYLINE_PATH_LIMIT` chapters. Every reader of the main route goes through
 * it, so the route the page draws and the one the viewer's rail marks are the same chapters.
 */
export const canonRouteWalk = (rootChapterId: number) => Prisma.sql`
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
    )`;

/** The chapters on the main route from `rootChapterId`, by id alone: no posts, images or counts. */
async function getStorylineMainRouteIds(rootChapterId: number) {
  const rows = await dbRead.$queryRaw<{ id: number }[]>`
    ${canonRouteWalk(rootChapterId)}
    SELECT main.id FROM main
  `;
  return new Set(rows.map((row) => row.id));
}

/**
 * The owner's main route from the first chapter: each chapter's canon child in turn, at most
 * `STORYLINE_PATH_LIMIT` chapters, with tombstones as in the reading path and how many ways on
 * each chapter has.
 */
async function getStorylineMainPath({
  rootChapterId,
  ceiling,
  viewer,
  browsingLevel,
  blockedUserIds,
  gate = getStorylineImageGate(viewer, browsingLevel, blockedUserIds),
}: {
  /** Where the route starts: chapter 1 for the whole route, any chapter for the canon after it. */
  rootChapterId: number;
  /** The ceiling chapters are held to (`storylineCeiling`), not the owner's setting alone. */
  ceiling: number;
  viewer: Viewer;
  browsingLevel: number;
  blockedUserIds: ReadonlySet<number>;
  /** A caller reading other images for the same reader passes its own. */
  gate?: StorylineImageGateSource;
}) {
  const rows = await dbRead.$queryRaw<RouteRow[]>`
    ${canonRouteWalk(rootChapterId)}
    SELECT main.id, main."postId", main.depth, main."removedAt",
      ARRAY(
        SELECT e."parentChapterId" FROM "StorylineChapterEdge" e
        WHERE e."chapterId" = main.id ORDER BY e."createdAt", e."parentChapterId"
      )::int[] AS "parentIds"
    FROM main ORDER BY hops
  `;
  if (!rows.length) return [];

  const chapterIds = rows.map((r) => r.id);
  const postIds = rows.flatMap((r) => (r.postId != null ? [r.postId] : []));
  const tombstoneOf = (post: StorylineChapterPost | null, removed: boolean) =>
    getStorylineChapterTombstone({
      post,
      removed,
      viewer,
      maxNsfwLevel: ceiling,
      browsingLevel,
      blockedUserIds,
    });
  const [posts, childCounts, joins] = await Promise.all([
    postIds.length
      ? dbRead.post.findMany({ where: { id: { in: postIds } }, select: castChapterPostSelect })
      : [],
    dbRead.storylineChapterEdge.groupBy({
      by: ['parentChapterId'],
      where: { parentChapterId: { in: chapterIds } },
      _count: { _all: true },
    }),
    getRouteJoins(rows, tombstoneOf),
  ]);
  const postById = new Map(posts.map((p) => [p.id, p]));
  const childCountById = new Map(childCounts.map((c) => [c.parentChapterId, c._count._all]));

  const route = rows.map((row) => {
    const post = row.postId != null ? postById.get(row.postId) ?? null : null;
    const chapter = toPathChapter(row, post, tombstoneOf(post, !!row.removedAt));
    return {
      ...chapter,
      post: chapter.post && post ? { ...chapter.post, user: toCastUser(post.user) } : null,
      childCount: childCountById.get(row.id) ?? 0,
      joins: joins.get(row.id) ?? [],
    };
  });
  return withFirstImages(gate, onRoute(rows, route));
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
    ceiling: storyline.maxNsfwLevel,
    viewer,
    browsingLevel,
    blockedUserIds,
  });
  // The route starts at the chapter asked about; the reader is already on it.
  return route.slice(1);
}

/**
 * Every chapter of a storyline and every link between them, for the Story page's map, with
 * tombstones as in the reading path. At most `STORYLINE_GRAPH_LIMIT` chapters, nearest chapter 1
 * first, so each one returned has its first parent too; `truncated` says there are more. Links
 * come oldest first, only between chapters returned.
 */
export async function getStorylineGraph({
  id,
  viewer,
  browsingLevel,
}: {
  id: number;
  viewer: Viewer;
  browsingLevel: number;
}) {
  const { storyline, blockedUserIds } = await getStorylineForRead(id, viewer, browsingLevel);
  const rows = await dbRead.storylineChapter.findMany({
    where: { storylineId: id },
    select: {
      id: true,
      depth: true,
      removedAt: true,
      placementId: true,
      post: { select: chapterPostSelect },
    },
    orderBy: [{ depth: 'asc' }, { id: 'asc' }],
    take: STORYLINE_GRAPH_LIMIT + 1,
  });
  const chapters = rows.slice(0, STORYLINE_GRAPH_LIMIT);
  const ids = new Set(chapters.map((c) => c.id));
  const edges = ids.size
    ? await dbRead.storylineChapterEdge.findMany({
        where: { storylineId: id, chapterId: { in: [...ids] } },
        select: { chapterId: true, parentChapterId: true, canon: true },
        orderBy: [{ createdAt: 'asc' }, { parentChapterId: 'asc' }],
      })
    : [];

  const tombstoneOf = (post: StorylineChapterPost | null, removed: boolean) =>
    getStorylineChapterTombstone({
      post,
      removed,
      viewer,
      maxNsfwLevel: storyline.maxNsfwLevel,
      browsingLevel,
      blockedUserIds,
    });
  return {
    rootChapterId: chapters[0]?.depth === 0 ? chapters[0].id : null,
    chapters: await withFirstImages(
      getStorylineImageGate(viewer, browsingLevel, blockedUserIds),
      chapters.map((c) => ({
        ...toPathChapter(c, c.post, tombstoneOf(c.post, !!c.removedAt)),
        viaPlacement: c.placementId != null,
      }))
    ),
    edges: edges.filter((e) => ids.has(e.parentChapterId)),
    truncated: rows.length > STORYLINE_GRAPH_LIMIT,
  };
}

/**
 * Chapter ratings for the owner choosing a ceiling, so the settings can warn how many chapters a
 * lower one would hide. Judged as the owner sees the story: a
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
 * Storyline membership for a page of posts, for the storyline pill on cards. A post is left out
 * when its storyline is hidden from this viewer or the post itself is outside their browsing
 * level, so the call cannot list stories the viewer could not open.
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
            minorByScan: true,
            tosViolation: true,
            ...storylineTitleLevelSelect,
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
    if (
      !isAuthor &&
      (!c.post.nsfwLevel ||
        outsideBrowsingLevel(c.post.nsfwLevel, browsingLevel) ||
        // Above the storyline's ceiling, the chapter is a tombstone inside it.
        !storylineLevelAllowed({
          postLevel: c.post.nsfwLevel,
          maxNsfwLevel: storylineCeiling(c.storyline),
        }))
    )
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
  // Readers get the ceiling chapters are held to, never the title scan's minor finding: these
  // reads are public, and the flag is a content classification.
  const {
    user: _user,
    chapters: firstChapters,
    minorByScan,
    nsfwLevel: _nsfwLevel,
    moderatorNsfwLevel: _moderatorNsfwLevel,
    ...rest
  } = storyline;
  return {
    storyline: { ...rest, maxNsfwLevel: storylineCeiling({ ...rest, minorByScan }) },
    blockedUserIds,
    /** Chapter 1, where the main route starts. */
    rootChapterId: firstChapters[0]?.id ?? null,
  };
}

/** Throws NotFound unless this viewer could open the storyline's page. */
export async function assertStorylineVisible(
  storylineId: number,
  viewer: Viewer,
  browsingLevel: number
) {
  const { storyline } = await getStorylineForRead(storylineId, viewer, browsingLevel);
  return { userId: storyline.userId, tosViolation: storyline.tosViolation };
}

/**
 * The reading path ending at `chapterId`, in order. A chapter this reader may not see is a
 * tombstone carrying the reason, never an error, so the chapters after it stay reachable.
 *
 * A chapter where branches rejoin has several parents. The path takes the one in `via` (the way
 * the reader came), else the oldest link, so a path is still one line; a `via` on no route to the
 * chapter changes nothing. Each chapter's `joins` are the other parents, and `depth` is its place
 * on this route.
 *
 * At most `STORYLINE_PATH_LIMIT` chapters, the ones nearest `chapterId`; `hasEarlier` says the
 * path starts further back, and the reader pages back by asking for the first chapter returned.
 */
export async function getStorylinePath({
  chapterId,
  via = [],
  viewer,
  browsingLevel,
}: {
  chapterId: number;
  via?: number[];
  viewer: Viewer;
  browsingLevel: number;
}) {
  const target = await dbRead.storylineChapter.findUnique({
    where: { id: chapterId },
    select: { storylineId: true },
  });
  if (!target) throw throwNotFoundError('Chapter not found');
  const { storyline, blockedUserIds, rootChapterId } = await getStorylineForRead(
    target.storylineId,
    viewer,
    browsingLevel
  );

  // Not bounded by the target's depth: a route through a longer branch exceeds its first-parent
  // distance. The window and `seen` bound the walk.
  const rows = await dbRead.$queryRaw<RouteRow[]>`
    WITH RECURSIVE path AS (
      SELECT c.id, c."postId", c.depth, c."removedAt", 0 AS hops, ARRAY[c.id] AS seen
      FROM "StorylineChapter" c
      WHERE c.id = ${chapterId}
      UNION ALL
      SELECT p.id, p."postId", p.depth, p."removedAt", path.hops + 1, path.seen || p.id
      FROM path
      CROSS JOIN LATERAL (
        SELECT e."parentChapterId" FROM "StorylineChapterEdge" e
        WHERE e."chapterId" = path.id
        ORDER BY e."parentChapterId" = ANY(${via}::int[]) DESC, e."createdAt", e."parentChapterId"
        LIMIT 1
      ) pick
      JOIN "StorylineChapter" p ON p.id = pick."parentChapterId"
      WHERE path.hops < ${STORYLINE_PATH_LIMIT - 1} AND p.id <> ALL(path.seen)
    )
    SELECT path.id, path."postId", path.depth, path."removedAt",
      ARRAY(
        SELECT e."parentChapterId" FROM "StorylineChapterEdge" e
        WHERE e."chapterId" = path.id ORDER BY e."createdAt", e."parentChapterId"
      )::int[] AS "parentIds"
    FROM path ORDER BY hops DESC
  `;

  const tombstoneOf = (post: StorylineChapterPost | null, removed: boolean) =>
    getStorylineChapterTombstone({
      post,
      removed,
      viewer,
      // Already the ceiling chapters are held to: `getStorylineForRead` applies it.
      maxNsfwLevel: storyline.maxNsfwLevel,
      browsingLevel,
      blockedUserIds,
    });
  const postIds = rows.flatMap((r) => (r.postId != null ? [r.postId] : []));
  const [posts, childCounts, joins, mainRouteIds] = await Promise.all([
    postIds.length
      ? dbRead.post.findMany({ where: { id: { in: postIds } }, select: chapterPostSelect })
      : [],
    rows.length
      ? dbRead.storylineChapterEdge.groupBy({
          by: ['parentChapterId'],
          where: { parentChapterId: { in: rows.map((r) => r.id) } },
          _count: { _all: true },
        })
      : [],
    getRouteJoins(rows, tombstoneOf),
    rootChapterId ? getStorylineMainRouteIds(rootChapterId) : new Set<number>(),
  ]);
  const postById = new Map(posts.map((p) => [p.id, p]));
  const childCountById = new Map(childCounts.map((c) => [c.parentChapterId, c._count._all]));

  const chapters = rows.map((row) => {
    const post = row.postId != null ? postById.get(row.postId) ?? null : null;
    return {
      ...toPathChapter(row, post, tombstoneOf(post, !!row.removedAt)),
      childCount: childCountById.get(row.id) ?? 0,
      joins: joins.get(row.id) ?? [],
      // On the owner's main route, which the viewer's rail leaves uncoloured.
      onMain: mainRouteIds.has(row.id),
    };
  });

  const gate = getStorylineImageGate(viewer, browsingLevel, blockedUserIds);
  const captionPostIds = chapters.flatMap((chapter) => (chapter.post ? [chapter.post.id] : []));
  const [routeChapters, captions] = await Promise.all([
    withFirstImages(gate, onRoute(rows, chapters)),
    (async () => {
      if (!captionPostIds.length) return new Map<number, string>();
      const { hiddenImageIds, hiddenTagIds } = await gate();
      return getStorylineImageCaptions({
        postIds: captionPostIds,
        browsingLevel,
        maxNsfwLevel: storyline.maxNsfwLevel,
        viewerId: viewer?.id,
        hiddenImageIds,
        hiddenTagIds,
      });
    })(),
  ]);
  return {
    storyline,
    chapters: routeChapters,
    /** Caption text by image id. */
    captions: Object.fromEntries(captions) as Record<number, string>,
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
      _count: { select: { parents: true } },
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
 * the limit. Reader counts come from a separate cached read, so ordering by them happens here.
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
      where: { storylineId: storyline.id, ...acceptedCollaboratorWhere },
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
      // Already the ceiling chapters are held to: `getStorylineForRead` applies it.
      maxNsfwLevel: storyline.maxNsfwLevel,
      browsingLevel,
      blockedUserIds,
    });
    return {
      ...toPathChapter(chapter, chapter.post, tombstone),
      parentCount: chapter._count.parents,
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

// Reader counts live in Postgres: one row per signed-in reader, a reader counting once per fork
// point by their latest choice, which is a primary key here. The direct ClickHouse writer skips
// every non-production deployment (`isProductionDeployment`), so counts kept there would never
// move on a preview or dev deployment.

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

/**
 * How the readers who chose at the end of a chapter went: each way on's count and share, once
 * enough choices (`STORYLINE_SHARE_MIN_CHOICES`) have been made; below that, only the total.
 */
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
  // cannot be read, mark the entry stale rather than fail the request.
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
 * are not counted.
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

type StorylineImageGate = {
  viewer: Viewer;
  browsingLevel: number;
  blockedUserIds: ReadonlySet<number>;
  hiddenImageIds: number[];
  hiddenTagIds: number[];
};

/**
 * The cached hidden set every image read applies (images and tags the reader hid, the site's
 * defaults for a signed-out reader), plus the browsing-settings exclusions every image feed
 * applies server-side for this level.
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
      // As the image feeds' middleware (middleware.trpc.ts): only tags the reader hid, and an
      // image hidden through a tag only while that tag is one of them. hiddenTags also carries
      // every tag rated above PG, which a reader's level, not a hide, decides.
      const hiddenTagIds = hidden.hiddenTags.filter((tag) => tag.hidden).map((tag) => tag.id);
      return {
        viewer,
        browsingLevel,
        blockedUserIds,
        hiddenImageIds: hidden.hiddenImages
          .filter((image) => !image.tagId || hiddenTagIds.includes(image.tagId))
          .map((image) => image.id),
        hiddenTagIds: [...new Set([...hiddenTagIds, ...(enforced.excludedTagIds ?? [])])],
      };
    })());
}

/**
 * An image this reader may be shown for a storyline: a chapter image, or an image in no chapter
 * that is listed as uploaded for this storyline. Expects `i` (Image), `p` (its Post, if any) and
 * `st` (the Storyline).
 */
function storylineImageVisible(gate: StorylineImageGate) {
  const viewerId = gate.viewer?.id ?? -1;
  return Prisma.sql`i.ingestion = 'Scanned' AND i."tosViolation" = false AND i."needsReview" IS NULL
      AND i."acceptableMinor" = false
      -- Shown to everyone who sees the card or page, so no minor or real-person image.
      AND i.minor = false AND i.poi = false
      AND (p.id IS NULL OR p.availability <> 'Private' OR p."userId" = ${viewerId})
      AND i."nsfwLevel" <> 0
      AND (i."nsfwLevel" & ${gate.browsingLevel}::int) <> 0
      AND (i."nsfwLevel" & ~(${storylineCeilingSql} * 2 - 1)) = 0
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
  const pairs = uniqBy(
    picks.flatMap((pick) => (pick.imageId ? [{ ...pick, imageId: pick.imageId }] : [])),
    (pick) => key(pick.storylineId, pick.imageId)
  );
  const found = new Map<string, StorylineFeedCover>();
  if (pairs.length) {
    const resolved = await gate();
    const rows = await dbRead.$queryRaw<
      (StorylineFeedCover & {
        storylineId: number;
        postId: number | null;
        chapterId: number | null;
        storylineUserId: number;
        uploaderIsModerator: boolean | null;
        uploaderBannedAt: Date | null;
        uploaderDeletedAt: Date | null;
        uploadedHere: boolean;
        postUserId: number;
        postNsfwLevel: number;
        publishedAt: Date | null;
        postTosViolation: boolean;
        removedAt: Date | null;
        bannedAt: Date | null;
        deletedAt: Date | null;
        maxNsfwLevel: number;
        minorByScan: boolean;
      })[]
    >`
      SELECT ${storylineImageColumns}, st.id AS "storylineId", i."postId", c.id AS "chapterId",
        p."userId" AS "postUserId", p."nsfwLevel" AS "postNsfwLevel", p."publishedAt",
        p."tosViolation" AS "postTosViolation", c."removedAt", pu."bannedAt", pu."deletedAt",
        st."maxNsfwLevel", st."minorByScan", st."userId" AS "storylineUserId",
        iu."isModerator" AS "uploaderIsModerator", iu."bannedAt" AS "uploaderBannedAt",
        iu."deletedAt" AS "uploaderDeletedAt", cu."imageId" IS NOT NULL AS "uploadedHere"
      FROM unnest(${pairs.map((pair) => pair.storylineId)}::int[], ${pairs.map(
      (pair) => pair.imageId
    )}::int[]) AS pick("storylineId", "imageId")
      JOIN "Image" i ON i.id = pick."imageId"
      JOIN "Storyline" st ON st.id = pick."storylineId"
      LEFT JOIN "StorylineChapter" c ON c."postId" = i."postId" AND c."storylineId" = st.id
      LEFT JOIN "Post" p ON p.id = i."postId"
      LEFT JOIN "User" pu ON pu.id = p."userId"
      JOIN "User" iu ON iu.id = i."userId"
      LEFT JOIN "StorylineCoverUpload" cu ON cu."storylineId" = st.id AND cu."imageId" = i.id
      WHERE ${storylineImageVisible(resolved)}
    `;
    for (const row of rows) {
      // A no-chapter cover must be listed as uploaded for this storyline, by its owner or a
      // moderator whose account still stands and whom this reader has not blocked.
      if (row.chapterId == null) {
        if (
          !row.postId &&
          row.uploadedHere &&
          (row.userId === row.storylineUserId || row.uploaderIsModerator) &&
          !row.uploaderBannedAt &&
          !row.uploaderDeletedAt &&
          !resolved.blockedUserIds.has(row.userId)
        )
          found.set(key(row.storylineId, row.id), toStorylineImage(row));
        continue;
      }
      const tombstone = getStorylineChapterTombstone({
        post: {
          id: row.postId!,
          userId: row.postUserId,
          nsfwLevel: row.postNsfwLevel,
          publishedAt: row.publishedAt,
          tosViolation: row.postTosViolation,
          user: { bannedAt: row.bannedAt, deletedAt: row.deletedAt },
        },
        removed: !!row.removedAt,
        viewer: resolved.viewer,
        // Judges the image's POST, which the SQL gate (per image) does not: a safe image from a
        // post that also holds one above the ceiling is not used as a pick.
        maxNsfwLevel: storylineCeiling(row),
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

export type StorylineFeedFilter = 'all' | 'ongoing' | 'complete' | 'open' | 'mine';
export type StorylineFeedSort = 'newest' | 'mostChapters';

/**
 * Storylines a reader may open, newest or with most chapters first. Hidden ones and stories
 * outside the reader's browsing level are left out, judged as everywhere else (see
 * `isStorylineHidden`, `isStorylineOutsideLevel`).
 *
 * "open" means accepting continuations from this reader: not Complete, the placement layer's
 * mode (the storyline's, else its owner's, else 'review') not 'off', and the reader among those
 * it takes them from.
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
    // As `isStorylineHidden`, including a storyline with no chapter 1 yet, except that a taken-down
    // one is out of the feed for its owner and moderators too. They still open it by its URL.
    Prisma.sql`st."tosViolation" = false`,
    Prisma.sql`(${isModerator} OR st."userId" = ${viewerId} OR (rc.id IS NOT NULL AND u."bannedAt" IS NULL AND u."deletedAt" IS NULL))`,
    Prisma.sql`(${isModerator} OR st."userId" = ${viewerId} OR (${storyLevelSql} & ${browsingLevel}::int) <> 0)`,
  ];
  // One array parameter, not one bind per id: the list can run to tens of thousands.
  if (excluded.length) where.push(Prisma.sql`st."userId" <> ALL(${excluded}::int[])`);
  if (filter === 'ongoing') where.push(Prisma.sql`st.status = 'Ongoing'`);
  if (filter === 'complete') where.push(Prisma.sql`st.status = 'Complete'`);
  if (filter === 'mine') where.push(Prisma.sql`st."userId" = ${viewerId}`);
  if (filter === 'open') {
    // A Complete storyline takes no continuations, whatever its space says.
    where.push(Prisma.sql`st.status <> 'Complete'`);
    where.push(Prisma.sql`COALESCE(ss.mode, us.mode, 'review') <> 'off'`);
    // Open to this reader: collaborators-only storylines are open only to their collaborators.
    where.push(Prisma.sql`(st."whoCanContinue" = 'Anyone' OR st."userId" = ${viewerId} OR EXISTS (
      SELECT 1 FROM "StorylineCollaborator" sc
      WHERE sc."storylineId" = st.id AND sc."userId" = ${viewerId} AND ${acceptedCollaboratorSql(
      'sc'
    )}
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
      minorByScan: boolean;
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
      st."maxNsfwLevel", st."minorByScan", st."whoCanContinue",
      EXISTS (
        SELECT 1 FROM "StorylineCollaborator" vc
        WHERE vc."storylineId" = st.id AND vc."userId" = ${viewerId} AND ${acceptedCollaboratorSql(
    'vc'
  )}
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
      // Chapter 1's post as a whole, so a card never takes its cover from a chapter that is a
      // placeholder inside the story, though each image is also gated in SQL.
      maxNsfwLevel: storylineCeiling(row),
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
      minorByScan,
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
        // The ceiling chapters are held to, which the card's rating chip shows.
        maxNsfwLevel: storylineCeiling({ maxNsfwLevel: row.maxNsfwLevel, minorByScan }),
        user: ownerById.get(userId) ?? { id: userId, username },
        coverImage:
          chosen(row.id, coverImageId) ??
          (row.rootPostId != null ? covers.get(row.rootPostId) ?? null : null),
        // The "open" filter, per card (its owner counts, as in the filter).
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
