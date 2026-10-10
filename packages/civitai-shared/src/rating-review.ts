import {
  browsingLevels,
  getBrowsingLevelLabel,
  NsfwLevel,
  nsfwBrowsingLevelsFlag,
} from './browsing-levels';

export const RATING_REVIEW_ENTITY_TYPES = [
  'Article',
  'Model',
  'Post',
  'Bounty',
  'BountyEntry',
  'Challenge',
  'Crucible',
  'Collection',
] as const;
export type RatingReviewEntityType = (typeof RATING_REVIEW_ENTITY_TYPES)[number];

export function isRatingReviewEntityType(v: unknown): v is RatingReviewEntityType {
  return typeof v === 'string' && (RATING_REVIEW_ENTITY_TYPES as readonly string[]).includes(v);
}

export const ratingReviewEntityLabels: Record<RatingReviewEntityType, string> = {
  Article: 'Article',
  Model: 'Model',
  Post: 'Post',
  Bounty: 'Bounty',
  BountyEntry: 'Bounty entry',
  Challenge: 'Challenge',
  Crucible: 'Crucible',
  Collection: 'Collection',
};

// A Model's rating override is its `nsfw` flag, not a level, so it is represented as PG (off) / R (on).
export const modelRatingLevel = (nsfw: boolean): number => (nsfw ? NsfwLevel.R : NsfwLevel.PG);

// Any NSFW bit in a collection's bucket reads as R.
export const collectionRatingLevel = (nsfwLevel: number): number =>
  nsfwLevel & nsfwBrowsingLevelsFlag ? NsfwLevel.R : NsfwLevel.PG;

// A collection's nsfwLevel is a bucket (SFW or every NSFW bit), so it has no level finer than PG/R.
export function ratingReviewLevels(entityType: RatingReviewEntityType): number[] {
  return entityType === 'Model' || entityType === 'Collection'
    ? [NsfwLevel.PG, NsfwLevel.R]
    : [...browsingLevels];
}

// A challenge's or crucible's level is an allowed-entry mask; raising one runs guarded side effects
// (entry voids, content checks, refunds) that only the main app can, so a dispute may only lower it.
const lowerOnly = (entityType: RatingReviewEntityType) =>
  entityType === 'Challenge' || entityType === 'Crucible';

export function ratingReviewOwnerLevels(
  entityType: RatingReviewEntityType,
  currentLevel: number
): number[] {
  const levels = ratingReviewLevels(entityType);
  return lowerOnly(entityType) ? levels.filter((l) => l < currentLevel) : levels;
}

export function ratingReviewModeratorLevels(
  entityType: RatingReviewEntityType,
  currentLevel: number
): number[] {
  const levels = ratingReviewLevels(entityType);
  return lowerOnly(entityType) ? levels.filter((l) => l <= currentLevel) : levels;
}

export function ratingReviewLevelLabel(
  entityType: RatingReviewEntityType,
  level: number | null | undefined
): string {
  if ((entityType === 'Model' || entityType === 'Collection') && level)
    return level >= NsfwLevel.R ? 'NSFW' : 'SFW';
  return getBrowsingLevelLabel(level);
}

export function ratingReviewEntityPath(
  entityType: RatingReviewEntityType,
  entityId: number,
  parentId?: number | null
): string | null {
  switch (entityType) {
    case 'Article':
      return `/articles/${entityId}`;
    case 'Model':
      return `/models/${entityId}`;
    case 'Post':
      return `/posts/${entityId}`;
    case 'Bounty':
      return `/bounties/${entityId}`;
    case 'BountyEntry':
      return parentId ? `/bounties/${parentId}/entries/${entityId}` : null;
    case 'Challenge':
      return `/challenges/${entityId}`;
    case 'Crucible':
      return `/crucibles/${entityId}`;
    case 'Collection':
      return `/collections/${entityId}`;
  }
}

// XGuard and Clavata rows share the `result` column with a different shape; `version` is what marks a
// text-scan row, the same test the scan floor applies (`result->>'version' IS NOT NULL`).
export function textScanNsfwReason(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as { version?: unknown; labels?: { nsfw?: { reason?: unknown } } };
  if (r.version == null) return null;
  const reason = r.labels?.nsfw?.reason;
  return typeof reason === 'string' && reason.trim() ? reason : null;
}

// The hash of the text a completed scan read. A skipped or in-flight scan leaves the previous
// one in place, so it only moves once a new verdict lands.
export function textScanResultTextHash(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as { version?: unknown; textHash?: unknown };
  if (r.version == null) return null;
  return typeof r.textHash === 'string' && r.textHash ? r.textHash : null;
}

export type RatingReviewNotificationDetails = {
  entityType: RatingReviewEntityType;
  entityId: number;
  title: string;
  url: string;
  previousLevel: string;
  appliedLevel: string;
  modComment: string | null;
};

export type RatingReviewNotification = {
  type: 'rating-review-approved' | 'rating-review-rejected';
  key: string;
  details: RatingReviewNotificationDetails;
};

export function buildRatingReviewNotification(input: {
  reviewId: number;
  approved: boolean;
  entityType: RatingReviewEntityType;
  entityId: number;
  parentId?: number | null;
  title: string;
  previousLevel: number;
  appliedLevel: number;
  modComment?: string | null;
}): RatingReviewNotification {
  const type = input.approved ? 'rating-review-approved' : 'rating-review-rejected';
  return {
    type,
    key: `${type}:${input.reviewId}`,
    details: {
      entityType: input.entityType,
      entityId: input.entityId,
      title: input.title,
      url: ratingReviewEntityPath(input.entityType, input.entityId, input.parentId) ?? '/',
      previousLevel: ratingReviewLevelLabel(input.entityType, input.previousLevel),
      appliedLevel: ratingReviewLevelLabel(input.entityType, input.appliedLevel),
      modComment: input.modComment ?? null,
    },
  };
}
