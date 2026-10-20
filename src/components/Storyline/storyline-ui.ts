import { browsingLevelLabels } from '~/shared/constants/browsingLevel.constants';
import { PLACEMENT_SURFACES, placementPriceCaption } from '~/shared/utils/placement';
import { STORYLINE_CEILING_LEVELS, storylineLevelAllowed } from '~/shared/utils/storyline';
import { numberWithCommas } from '~/utils/number-helpers';

/**
 * Who may continue a storyline; the values of the `StorylineWhoCanContinue` enum. Endorsed
 * collaborators may always continue, and skip review.
 */
export type StorylineWhoCanContinue = 'Anyone' | 'Collaborators';

export const STORYLINE_WHO_CAN_CONTINUE = [
  { value: 'Anyone', label: 'Anyone, I review first' },
  { value: 'Collaborators', label: 'Only collaborators' },
] as const satisfies readonly { value: StorylineWhoCanContinue; label: string }[];

export const isStorylineWhoCanContinue = (value: unknown): value is StorylineWhoCanContinue =>
  value === 'Anyone' || value === 'Collaborators';

export type StorylineClosedReason = 'closed' | 'collaboratorsOnly';

export function storylinePriceLabel(price: number) {
  return price > 0 ? `${numberWithCommas(price)} Buzz` : 'Free';
}

export function storylinePriceCaption(price: number, cap: number | null) {
  if (price <= 0) return { text: 'Free to continue', warning: false };
  return (
    placementPriceCaption('storyline', price, cap, 'Contributors') ?? {
      text: `Contributors pay ${storylinePriceLabel(price)}`,
      warning: false,
    }
  );
}

export const STORYLINE_RATING_OPTIONS = STORYLINE_CEILING_LEVELS.map((level) => ({
  value: level,
  label: browsingLevelLabels[level],
}));

export const STORYLINE_CONTINUE_POST_LIMIT = 50;

/** The viewer's own posts, minus the chapter being continued. */
export function storylineContinuePostOptions<TImage>(
  posts: {
    id: number;
    title: string | null;
    nsfwLevel: number;
    publishedAt: Date | null;
    imageCount: number;
    user: { id: number };
    images: TImage[];
  }[],
  { viewerId, parentPostId }: { viewerId: number; parentPostId: number }
) {
  return posts
    .filter((post) => post.user.id === viewerId && post.id !== parentPostId)
    .map(({ id, title, nsfwLevel, publishedAt, imageCount, images }) => ({
      id,
      title,
      nsfwLevel,
      publishedAt,
      imageCount,
      cover: images[0] ?? null,
    }));
}

/**
 * Posts that are already a chapter cannot continue another storyline (the server refuses them),
 * so they are left out of the picker and only counted.
 */
export function storylineWithoutChapters<T extends { id: number }>(
  posts: T[],
  chapterPostIds: ReadonlySet<number>
) {
  const usable = posts.filter((post) => !chapterPostIds.has(post.id));
  return { posts: usable, alreadyChapters: posts.length - usable.length };
}

/**
 * What submit sends. The price is the one the contributor was shown, so a change while they
 * decide is refused rather than charged; an unrated post is sent and waits for its rating.
 */
export function storylineSubmitInput({
  parentPostId,
  post,
  shownPrice,
}: {
  parentPostId: number;
  post: { id: number; nsfwLevel: number };
  shownPrice: number;
}) {
  return {
    parentPostId,
    postId: post.id,
    expectedPrice: shownPrice,
    awaitingScan: !post.nsfwLevel,
  };
}

export type StorylineChapterLevels = { rootNsfwLevel: number | null; chapterLevels: number[] };

/**
 * What a ceiling does to a storyline that already has chapters. Chapter 1 sets the floor: the
 * server refuses a ceiling below it, so a story can never open on a hidden chapter. Any later
 * chapter above the ceiling is hidden from readers until it is raised again. Unrated chapters
 * (level 0) are not counted; they are hidden for being unrated, whatever the ceiling.
 */
export function storylineCeilingImpact(ceiling: number, levels: StorylineChapterLevels) {
  const fits = (postLevel: number) => storylineLevelAllowed({ postLevel, maxNsfwLevel: ceiling });
  return {
    allowed: levels.rootNsfwLevel == null || fits(levels.rootNsfwLevel),
    hidden: levels.chapterLevels.filter((level) => level > 0 && !fits(level)).length,
  };
}

/** How long a continuation waits for the creator before it expires and any Buzz is refunded. */
export const STORYLINE_CONTINUATION_EXPIRY_DAYS = PLACEMENT_SURFACES.storyline.expiryHours / 24;

export type StorylineSubmitVerdict =
  | { allowed: true; awaitingScan: boolean }
  | {
      allowed: false;
      reason: 'ownStoryline' | 'complete' | StorylineClosedReason | 'aboveRating' | 'notRated';
    };

/**
 * What the contributor is told before they press Submit. The server decides; this only says up
 * front what it would refuse. An unrated post is not refused here (the placement waits for its scan
 * and is refused or queued then), except when the owner adds it directly.
 */
export function storylineSubmitVerdict({
  postLevel,
  viewerId,
  storyline,
  closedReason,
  asOwner = false,
}: {
  postLevel: number;
  viewerId: number;
  storyline: { userId: number; status: 'Ongoing' | 'Complete'; maxNsfwLevel: number };
  /** From the server's read for this viewer; `null` when they may continue. */
  closedReason: StorylineClosedReason | null;
  /**
   * The owner adding their own chapter: who may continue does not apply to them, and an unrated
   * post is refused rather than queued, because nothing reviews it afterwards.
   */
  asOwner?: boolean;
}): StorylineSubmitVerdict {
  if (asOwner) {
    if (storyline.userId !== viewerId) return { allowed: false, reason: 'ownStoryline' };
    if (storyline.status === 'Complete') return { allowed: false, reason: 'complete' };
    if (!postLevel) return { allowed: false, reason: 'notRated' };
    if (!storylineLevelAllowed({ postLevel, maxNsfwLevel: storyline.maxNsfwLevel }))
      return { allowed: false, reason: 'aboveRating' };
    return { allowed: true, awaitingScan: false };
  }
  if (storyline.userId === viewerId) return { allowed: false, reason: 'ownStoryline' };
  if (storyline.status === 'Complete') return { allowed: false, reason: 'complete' };
  if (closedReason) return { allowed: false, reason: closedReason };
  if (!postLevel) return { allowed: true, awaitingScan: true };
  if (!storylineLevelAllowed({ postLevel, maxNsfwLevel: storyline.maxNsfwLevel }))
    return { allowed: false, reason: 'aboveRating' };
  return { allowed: true, awaitingScan: false };
}
