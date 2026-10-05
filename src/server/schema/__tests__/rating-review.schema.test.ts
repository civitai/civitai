import { describe, expect, it } from 'vitest';
import {
  createRatingReviewSchema,
  ratingDisputeFeature,
} from '~/server/schema/rating-review.schema';

describe('rating-review schema', () => {
  it('keeps Article on its own flag and every other entity on ratingDispute', () => {
    expect(ratingDisputeFeature('Article')).toBe('articleRatingDispute');
    expect(ratingDisputeFeature('BountyEntry')).toBe('ratingDispute');
  });

  it('rejects an unknown entity type and an over-long comment', () => {
    expect(
      createRatingReviewSchema.safeParse({ entityType: 'Image', entityId: 1, suggestedLevel: 1 })
        .success
    ).toBe(false);
    expect(
      createRatingReviewSchema.safeParse({
        entityType: 'Post',
        entityId: 1,
        suggestedLevel: 1,
        userComment: 'x'.repeat(501),
      }).success
    ).toBe(false);
  });
});
