import { describe, it, expect } from 'vitest';
import { shouldShowPendingReviewBadge } from '~/components/Image/Infinite/pending-review-badge.utils';

describe('shouldShowPendingReviewBadge', () => {
  it('shows for the owner when status is REVIEW', () => {
    expect(shouldShowPendingReviewBadge({ userId: 7, collectionItemStatus: 'REVIEW' }, 7)).toBe(true);
  });
  it('hides for non-owners', () => {
    expect(shouldShowPendingReviewBadge({ userId: 7, collectionItemStatus: 'REVIEW' }, 9)).toBe(false);
  });
  it('hides when not under review', () => {
    expect(shouldShowPendingReviewBadge({ userId: 7, collectionItemStatus: 'ACCEPTED' }, 7)).toBe(false);
  });
  it('hides when status is absent (non-collection feed)', () => {
    expect(shouldShowPendingReviewBadge({ userId: 7 }, 7)).toBe(false);
  });
  it('hides for anonymous viewers', () => {
    expect(shouldShowPendingReviewBadge({ userId: 7, collectionItemStatus: 'REVIEW' }, undefined)).toBe(false);
  });
});
