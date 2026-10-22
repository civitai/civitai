import {
  ratingReviewLevelLabel,
  ratingReviewEntityLabels,
  type RatingReviewEntityType,
} from '@civitai/shared/rating-review';
import type { RatingReviewStatusFilter } from './rating-review';

export const DISPUTE_TABS = ['posts', 'models', 'articles', 'other'] as const;
export type DisputeTab = (typeof DISPUTE_TABS)[number];

export const DEFAULT_DISPUTE_TAB: DisputeTab = 'posts';

export const DISPUTE_TAB_TYPES: Record<DisputeTab, readonly RatingReviewEntityType[]> = {
  posts: ['Post'],
  models: ['Model'],
  articles: ['Article'],
  other: ['Bounty', 'BountyEntry', 'Challenge', 'Crucible', 'Collection'],
};

export const DISPUTE_TAB_LABELS: Record<DisputeTab, { label: string; hint: string; noun: string }> =
  {
    posts: { label: 'Posts', hint: 'image sets, rated by their highest image', noun: 'post' },
    models: { label: 'Models', hint: 'SFW or NSFW only', noun: 'model' },
    articles: { label: 'Articles', hint: 'cover and body text', noun: 'article' },
    other: {
      label: 'Other',
      hint: 'bounties, challenges, crucibles, collections',
      noun: 'other',
    },
  };

export const DISPUTE_SORTS = ['oldest', 'newest'] as const;
export type DisputeSort = (typeof DISPUTE_SORTS)[number];
export const DISPUTE_SORT_LABELS: Record<DisputeSort, string> = {
  oldest: 'Oldest first',
  newest: 'Newest first',
};

/** A pending queue is worked from the longest wait; decided rows read newest first. */
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

/** The caption over a detail pane's images: what they are, and how many there are in all. */
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

/**
 * What applying `chosen` does. A dispute is approved exactly when the owner's ask is applied to an
 * entity that still exists; any other level overrides it, and a deleted entity records a rejection
 * and applies nothing (the same rule the resolve action applies).
 */
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
