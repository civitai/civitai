import { describe, expect, it } from 'vitest';
import { challengeAllowedMaskAt, ratingReviewActivityEntityType } from '../rating-review-apply';

describe('challengeAllowedMaskAt', () => {
  it('drops the bits above the applied level', () => {
    expect(challengeAllowedMaskAt(1 | 2 | 4, 2)).toBe(1 | 2);
  });

  it('never leaves an empty mask', () => {
    expect(challengeAllowedMaskAt(4, 2)).toBe(2);
  });

  it('keeps a mask that is already at or below the level', () => {
    expect(challengeAllowedMaskAt(1 | 2, 4)).toBe(1 | 2);
  });
});

describe('ratingReviewActivityEntityType', () => {
  it('writes the lower-camel form ModActivity readers match on', () => {
    // `user-account.service.ts` ACTIVITY_CONTENT matches 'article' and 'model' exactly.
    expect(ratingReviewActivityEntityType('Article')).toBe('article');
    expect(ratingReviewActivityEntityType('Model')).toBe('model');
    expect(ratingReviewActivityEntityType('BountyEntry')).toBe('bountyEntry');
  });
});
