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

/** Most children an end-of-chapter listing reads. Ordering by readers happens after the read. */
export const STORYLINE_CHILDREN_LIMIT = 200;
/** Most chapters one path read returns, ending at the chapter asked for. */
export const STORYLINE_PATH_LIMIT = 200;
export const STORYLINE_MAX_COLLABORATORS = 50;

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
  /** Taken down by a moderator, or its author's account is banned or deleted. */
  | 'removed'
  /**
   * Not published, not rated yet, or the reader and the chapter's author have blocked one
   * another. A block is reported as this, never as itself, so a reader cannot learn that an
   * author blocked them.
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
  viewer,
  maxNsfwLevel,
  browsingLevel,
  blockedUserIds,
  now = new Date(),
}: {
  post: StorylineChapterPost | null;
  viewer: { id: number; isModerator?: boolean } | undefined;
  maxNsfwLevel: number;
  browsingLevel: number;
  blockedUserIds: ReadonlySet<number>;
  now?: Date;
}): StorylineTombstoneReason | null {
  if (!post) return 'deleted';
  const isModerator = !!viewer?.isModerator;
  const isAuthor = viewer?.id === post.userId;

  if (!isModerator && (post.tosViolation || post.user.bannedAt || post.user.deletedAt))
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
