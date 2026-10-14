import {
  browsingLevelLabels,
  getHighestBrowsingLevelBit,
} from '~/shared/constants/browsingLevel.constants';
import { placementPriceCaption } from '~/shared/utils/placement';
import { STORYLINE_CEILING_LEVELS, storylineLevelAllowed } from '~/shared/utils/storyline';
import { numberWithCommas } from '~/utils/number-helpers';

/**
 * Who may continue a storyline; the values of the `StorylineWhoCanContinue` column. Endorsed
 * collaborators may always continue, and skip review.
 */
export type StorylineWhoCanContinue = 'Anyone' | 'Collaborators';

export const STORYLINE_WHO_CAN_CONTINUE = [
  { value: 'Anyone', label: 'Anyone, I review first' },
  { value: 'Collaborators', label: 'Only collaborators' },
] as const satisfies readonly { value: StorylineWhoCanContinue; label: string }[];

export const isStorylineWhoCanContinue = (value: unknown): value is StorylineWhoCanContinue =>
  value === 'Anyone' || value === 'Collaborators';

/** Why the server says this viewer cannot continue a storyline right now. */
export type StorylineClosedReason = 'closed' | 'collaboratorsOnly';

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
      reason: 'ownStoryline' | 'complete' | StorylineClosedReason | 'aboveRating';
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
  closedReason,
}: {
  postLevel: number;
  viewerId: number;
  storyline: { userId: number; status: 'Ongoing' | 'Complete'; maxNsfwLevel: number };
  /** From the server's read for this viewer; `null` when they may continue. */
  closedReason: StorylineClosedReason | null;
}): StorylineSubmitVerdict {
  if (storyline.userId === viewerId) return { allowed: false, reason: 'ownStoryline' };
  if (storyline.status === 'Complete') return { allowed: false, reason: 'complete' };
  if (closedReason) return { allowed: false, reason: closedReason };
  if (!postLevel) return { allowed: true, awaitingScan: true };
  if (!storylineLevelAllowed({ postLevel, maxNsfwLevel: storyline.maxNsfwLevel }))
    return { allowed: false, reason: 'aboveRating' };
  return { allowed: true, awaitingScan: false };
}
