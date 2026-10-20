import { NsfwLevel } from '~/server/common/enums';
import { getHighestBrowsingLevelBit } from '~/shared/constants/browsingLevel.constants';

/** The ratings a storyline's ceiling may be set to. Mirrors the CHECK on `Storyline.maxNsfwLevel`. */
export const STORYLINE_CEILING_LEVELS = [
  NsfwLevel.PG,
  NsfwLevel.PG13,
  NsfwLevel.R,
  NsfwLevel.X,
  NsfwLevel.XXX,
] as const;

export const isStorylineCeilingLevel = (value: number) =>
  (STORYLINE_CEILING_LEVELS as readonly number[]).includes(value);

/**
 * The highest a chapter may be rated in a storyline whose title the scan found to be about a
 * minor: safe for work, as for a minor-flagged model (`modelBrowsingLevelLimit`).
 */
export const STORYLINE_MINOR_CEILING = NsfwLevel.PG13;

/**
 * The ceiling every chapter is held to: the owner's, lowered to safe for work while the title
 * scan restricts the storyline (`minorByScan`). The owner's own setting is kept, so a clean rescan
 * gives it back. Read this, never `maxNsfwLevel` alone, wherever a chapter or image is gated.
 */
export const storylineCeiling = (storyline: { maxNsfwLevel: number; minorByScan: boolean }) =>
  storyline.minorByScan
    ? Math.min(storyline.maxNsfwLevel, STORYLINE_MINOR_CEILING)
    : storyline.maxNsfwLevel;

/** Most children an end-of-chapter listing reads. Ordering by readers happens after the read. */
export const STORYLINE_CHILDREN_LIMIT = 200;
/** Most chapters one path read returns, ending at the chapter asked for. */
export const STORYLINE_PATH_LIMIT = 200;
/** Most chapters the Story page's map reads, nearest chapter 1 first. */
export const STORYLINE_GRAPH_LIMIT = 300;
export const STORYLINE_MAX_COLLABORATORS = 50;
/** Most chapter authors a storyline header lists besides its owner and collaborators. */
export const STORYLINE_MAX_CONTRIBUTORS = 50;

/**
 * Whether a post's rating fits under a storyline's ceiling.
 *
 * A post's `nsfwLevel` is the OR of its images' levels, so the post is judged by its most
 * severe image. 0 means not yet rated: it is refused, not treated as PG, so an unscanned post
 * cannot enter a story with a low ceiling. Blocked is above every ceiling.
 */
export function storylineLevelAllowed({
  postLevel,
  maxNsfwLevel,
}: {
  postLevel: number;
  maxNsfwLevel: number;
}) {
  if (!postLevel) return false;
  const highest = getHighestBrowsingLevelBit(postLevel);
  if (!highest || highest === NsfwLevel.Blocked) return false;
  return highest <= maxNsfwLevel;
}

export type StorylineChapterRank = 'canon' | 'endorsed' | 'community';

/**
 * A chapter's rank among its siblings. Only `canon` is stored; endorsed versus community
 * follows the CURRENT collaborator list, so endorsing someone also promotes the chapters they
 * already wrote, and removing them demotes those chapters.
 */
export function getStorylineChapterRank({
  canon,
  authorId,
  collaboratorIds,
}: {
  canon: boolean;
  authorId: number;
  collaboratorIds: ReadonlySet<number>;
}): StorylineChapterRank {
  if (canon) return 'canon';
  if (collaboratorIds.has(authorId)) return 'endorsed';
  return 'community';
}

const rankOrder: Record<StorylineChapterRank, number> = { canon: 0, endorsed: 1, community: 2 };

/**
 * End-of-chapter order: canon, then endorsed collaborators, then everyone else. Within a rank,
 * more readers first, then oldest first so the order is stable while counts are tied or absent.
 */
export function compareStorylineChildren(
  a: { rank: StorylineChapterRank; readers: number; createdAt: Date; chapterId: number },
  b: { rank: StorylineChapterRank; readers: number; createdAt: Date; chapterId: number }
) {
  return (
    rankOrder[a.rank] - rankOrder[b.rank] ||
    b.readers - a.readers ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    a.chapterId - b.chapterId
  );
}

/**
 * Why a chapter is not shown to this reader. A chapter that cannot be shown stays in the path as
 * a tombstone so the chapters after it stay reachable.
 */
export type StorylineTombstoneReason =
  /** The post no longer exists. */
  | 'deleted'
  /**
   * Taken down by a moderator, its author's account is banned or deleted, or the placement that
   * added it was removed.
   */
  | 'removed'
  /**
   * Not published, not rated yet, or by an author the reader blocked, was blocked by, or hid.
   * A block is reported as this, never as itself, so a reader cannot learn that an author
   * blocked them.
   */
  | 'unavailable'
  /** Rated above this storyline's ceiling. */
  | 'aboveStoryRating'
  /** Outside the reader's own browsing level. */
  | 'browsingLevel';

export type StorylineChapterPost = {
  id: number;
  userId: number;
  nsfwLevel: number;
  publishedAt: Date | null;
  tosViolation: boolean;
  user: { bannedAt: Date | null; deletedAt: Date | null };
};

/**
 * Whether one chapter is shown to one reader, and if not, why. Order matters: the first reason
 * that applies is the one reported, and the most permanent reasons come first.
 *
 * The author and moderators see a chapter that is unpublished or unrated, as they would the post.
 * Nobody is exempt from the story's ceiling or their own browsing level: this is a reading view.
 */
export function getStorylineChapterTombstone({
  post,
  removed = false,
  viewer,
  maxNsfwLevel,
  browsingLevel,
  blockedUserIds,
  now = new Date(),
}: {
  post: StorylineChapterPost | null;
  /** The chapter's own `removedAt` is set. */
  removed?: boolean;
  viewer: { id: number; isModerator?: boolean } | undefined;
  maxNsfwLevel: number;
  browsingLevel: number;
  blockedUserIds: ReadonlySet<number>;
  now?: Date;
}): StorylineTombstoneReason | null {
  if (!post) return 'deleted';
  const isModerator = !!viewer?.isModerator;
  const isAuthor = viewer?.id === post.userId;

  if (!isModerator && (removed || post.tosViolation || post.user.bannedAt || post.user.deletedAt))
    return 'removed';
  if (!isAuthor && blockedUserIds.has(post.userId)) return 'unavailable';

  const published = !!post.publishedAt && post.publishedAt < now;
  if (!isAuthor && !isModerator && (!published || !post.nsfwLevel)) return 'unavailable';

  if (!storylineLevelAllowed({ postLevel: post.nsfwLevel, maxNsfwLevel })) {
    // An unrated chapter the author can still see is "unavailable" to them, not over the line.
    return post.nsfwLevel ? 'aboveStoryRating' : 'unavailable';
  }
  if ((post.nsfwLevel & browsingLevel) === 0) return 'browsingLevel';
  return null;
}

/**
 * Choices at a fork below which its shares are withheld, unless `STORYLINE_SHARE_MIN_CHOICES` sets
 * another.
 */
export const STORYLINE_SHARE_MIN_CHOICES_DEFAULT = 1;

/**
 * The fork-share minimum from its raw setting: a whole number of at least 1, or the default for
 * anything else (unset, empty, zero, negative, fractional, not a number). Never below 1, so a
 * share always has a reader behind it.
 */
export function storylineShareMinChoices(raw: string | undefined) {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return STORYLINE_SHARE_MIN_CHOICES_DEFAULT;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value >= 1 ? value : STORYLINE_SHARE_MIN_CHOICES_DEFAULT;
}

/**
 * Each way on's count and share of the readers who chose at a fork. A way nobody took is absent
 * from both. Below `minChoices` choices both are withheld and only the total is given (`enough:
 * false`): with very few readers, someone who knows who read the chapter could tell which way they
 * went. `STORYLINE_SHARE_MIN_CHOICES` sets the minimum.
 */
export function toStorylineForkShares(
  counts: ReadonlyMap<number, number>,
  minChoices: number
): {
  enough: boolean;
  total: number;
  minChoices: number;
  counts: Record<number, number>;
  shares: Record<number, number>;
} {
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
  const enough = total >= minChoices && total > 0;
  const byChapter: Record<number, number> = {};
  const shares: Record<number, number> = {};
  if (enough)
    for (const [chapterId, n] of counts) {
      byChapter[chapterId] = n;
      shares[chapterId] = n / total;
    }
  return { enough, total, minChoices, counts: byChapter, shares };
}
