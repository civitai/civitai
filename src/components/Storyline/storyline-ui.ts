import {
  browsingLevelLabels,
  getHighestBrowsingLevelBit,
} from '~/shared/constants/browsingLevel.constants';
import { placementPriceCaption } from '~/shared/utils/placement';
import { STORYLINE_CEILING_LEVELS, storylineLevelAllowed } from '~/shared/utils/storyline';
import { numberWithCommas } from '~/utils/number-helpers';

/** Who may continue a storyline. The values are the storyline placement space's modes. */
export type StorylineContinueMode = 'review' | 'off';

export const STORYLINE_CONTINUE_MODES = [
  { value: 'review', label: 'Anyone, I review first' },
  { value: 'off', label: 'Only collaborators' },
] as const satisfies readonly { value: StorylineContinueMode; label: string }[];

export const isStorylineContinueMode = (value: unknown): value is StorylineContinueMode =>
  value === 'review' || value === 'off';

export function storylinePriceLabel(price: number) {
  return price > 0 ? `${numberWithCommas(price)} Buzz` : 'Free';
}

/** The line under the price slider. Zero is a price on this surface, and it reads as Free. */
export function storylinePriceCaption(price: number, cap: number | null) {
  if (price <= 0) return { text: 'Free to continue', warning: false };
  return (
    placementPriceCaption('storyline', price, cap, 'Contributors') ?? {
      text: `Contributors pay ${storylinePriceLabel(price)}`,
      warning: false,
    }
  );
}

export function storylineRatingLabel(level: number) {
  const highest = getHighestBrowsingLevelBit(level);
  return browsingLevelLabels[highest as keyof typeof browsingLevelLabels] ?? '?';
}

export const STORYLINE_RATING_OPTIONS = STORYLINE_CEILING_LEVELS.map((level) => ({
  value: level,
  label: browsingLevelLabels[level],
}));

/** How long a continuation waits for the creator before it expires and any Buzz is refunded. */
export const STORYLINE_CONTINUATION_EXPIRY_DAYS = 7;

export type StorylineSubmitVerdict =
  | { allowed: true; awaitingScan: boolean }
  | {
      allowed: false;
      reason: 'ownStoryline' | 'complete' | 'collaboratorsOnly' | 'aboveRating';
    };

/**
 * What the contributor is told before they press Submit.
 *
 * The server decides; this only says up front what it would refuse, so nobody fills in a
 * submission to learn at the end that it could never have gone in. An unrated post is not refused
 * here: the placement waits for its scan and is refused or queued then.
 */
export function storylineSubmitVerdict({
  postLevel,
  viewerId,
  storyline,
  mode,
  isCollaborator,
}: {
  postLevel: number;
  viewerId: number;
  storyline: { userId: number; status: 'Ongoing' | 'Complete'; maxNsfwLevel: number };
  mode: StorylineContinueMode;
  isCollaborator: boolean;
}): StorylineSubmitVerdict {
  if (storyline.userId === viewerId) return { allowed: false, reason: 'ownStoryline' };
  if (storyline.status === 'Complete') return { allowed: false, reason: 'complete' };
  if (mode === 'off' && !isCollaborator) return { allowed: false, reason: 'collaboratorsOnly' };
  if (!postLevel) return { allowed: true, awaitingScan: true };
  if (!storylineLevelAllowed({ postLevel, maxNsfwLevel: storyline.maxNsfwLevel }))
    return { allowed: false, reason: 'aboveRating' };
  return { allowed: true, awaitingScan: false };
}
