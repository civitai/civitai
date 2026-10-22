import { NsfwLevel } from '@civitai/shared';
import {
  ratingReviewLevelLabel,
  ratingReviewEntityLabels,
  type RatingReviewEntityType,
} from '@civitai/shared/rating-review';
import type { RatingReviewStatusFilter } from './rating-review';

export const DISPUTE_TABS = ['posts', 'models', 'articles', 'other'] as const;
export type DisputeTab = (typeof DISPUTE_TABS)[number];

export const DEFAULT_DISPUTE_TAB: DisputeTab = 'posts';

export const OTHER_KINDS = [
  'Bounty',
  'BountyEntry',
  'Challenge',
  'Crucible',
  'Collection',
] as const satisfies readonly RatingReviewEntityType[];
export type OtherKind = (typeof OTHER_KINDS)[number];

export const DISPUTE_TAB_TYPES: Record<DisputeTab, readonly RatingReviewEntityType[]> = {
  posts: ['Post'],
  models: ['Model'],
  articles: ['Article'],
  other: OTHER_KINDS,
};

export const DISPUTE_TAB_LABELS: Record<DisputeTab, { label: string; noun: string }> = {
  posts: { label: 'Posts', noun: 'post' },
  models: { label: 'Models', noun: 'model' },
  articles: { label: 'Articles', noun: 'article' },
  other: { label: 'Other', noun: 'other' },
};

export const KIND_FILTERS = ['all', ...OTHER_KINDS] as const;
export const KIND_LABELS: Record<(typeof KIND_FILTERS)[number], string> = {
  all: 'All',
  Bounty: ratingReviewEntityLabels.Bounty,
  BountyEntry: ratingReviewEntityLabels.BountyEntry,
  Challenge: ratingReviewEntityLabels.Challenge,
  Crucible: ratingReviewEntityLabels.Crucible,
  Collection: ratingReviewEntityLabels.Collection,
};

// PG-13 is intentionally shown unblurred; only R and above is NSFW.
export const isNsfwRating = (level: number) => level >= NsfwLevel.R;

export const DISPUTE_SORTS = ['oldest', 'newest'] as const;
export type DisputeSort = (typeof DISPUTE_SORTS)[number];
export const DISPUTE_SORT_LABELS: Record<DisputeSort, string> = {
  oldest: 'Oldest first',
  newest: 'Newest first',
};

export const defaultDisputeSort = (status: RatingReviewStatusFilter): DisputeSort =>
  status === 'Pending' ? 'oldest' : 'newest';

export const ASK_FILTERS = ['all', 'lower', 'higher'] as const;
export const ASK_LABELS = { all: 'All', lower: 'Asks lower', higher: 'Asks higher' } as const;
export const SCAN_LABELS = { all: 'All', raised: 'Scan raised' } as const;

export const disputeTitle = (
  entityType: RatingReviewEntityType,
  entityId: number,
  entity: { title: string } | null
) => entity?.title ?? `${ratingReviewEntityLabels[entityType]} #${entityId}`;

export function imageCaption(
  entityType: RatingReviewEntityType,
  total: number
): { title: string; hint?: string } {
  switch (entityType) {
    case 'Post':
      return { title: `IMAGES (${total})`, hint: 'a post is rated by its highest image' };
    case 'Model':
      return { title: `COVER AND SAMPLES (${total})` };
    case 'Article':
      return { title: `COVER AND INLINE IMAGES (${total})` };
    case 'Challenge':
      return { title: 'COVER' };
    default:
      return { title: 'IMAGES' };
  }
}

export const isLowerOnly = (entityType: RatingReviewEntityType) =>
  entityType === 'Challenge' || entityType === 'Crucible';

/** Must match the resolve action: approved exactly when the ask is applied to a live entity; a deleted entity rejects and applies nothing. */
export function disputeOutcome(
  entityType: RatingReviewEntityType,
  levels: { current: number; suggested: number; chosen: number },
  entityExists: boolean
): { approves: boolean; label: string; effect: string } {
  const { current, suggested, chosen } = levels;
  if (!entityExists)
    return {
      approves: false,
      label: 'Rejects dispute',
      effect: 'Content was deleted; nothing will be applied.',
    };
  const level = ratingReviewLevelLabel(entityType, chosen);
  const flag = entityType === 'Model' || entityType === 'Collection';
  // A flag shows as SFW or NSFW, so two NSFW levels change nothing the moderator can see.
  const unchanged = flag
    ? level === ratingReviewLevelLabel(entityType, current)
    : chosen === current;
  const effect = unchanged
    ? `Keeps ${level}.`
    : flag
    ? `Sets ${ratingReviewEntityLabels[entityType].toLowerCase()} to ${level}.`
    : chosen > current
    ? `Raises to ${level}.`
    : `Lowers to ${level}.`;
  const approves = chosen === suggested;
  return { approves, label: approves ? 'Approves dispute' : 'Rejects dispute', effect };
}

const RECORDED_VERDICTS: Record<string, string> = { Actioned: 'Approved', Unactioned: 'Rejected' };

/** The row verdict relabelled with the status the server recorded, which the optimistic label can miss. */
export function recordedVerdict(status: unknown, outcome: string): string {
  const verdict = typeof status === 'string' ? RECORDED_VERDICTS[status] : undefined;
  if (!verdict) return outcome;
  const detail = outcome.indexOf(':');
  return detail < 0 ? verdict : verdict + outcome.slice(detail);
}
