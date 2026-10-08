import type { RatingReviewEntityType } from '@civitai/shared/rating-review';

export function challengeAllowedMaskAt(allowed: number, level: number): number {
  return allowed & (level * 2 - 1) || level;
}

export const ratingReviewActivityEntityType = (entityType: RatingReviewEntityType): string =>
  entityType.charAt(0).toLowerCase() + entityType.slice(1);
