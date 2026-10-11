import { describe, expect, it } from 'vitest';
import { ownerRatingButtonState } from '~/components/RatingReview/owner-rating-state';

const at = new Date('2026-09-02T00:00:00Z');

describe('ownerRatingButtonState', () => {
  it('opens with no review', () => {
    expect(ownerRatingButtonState(null, true)).toEqual({ kind: 'open' });
  });

  it('is pending while a review is pending, whatever the server says about resubmit', () => {
    expect(
      ownerRatingButtonState(
        { status: 'Pending', createdAt: at, resolvedAt: null, modComment: null },
        true
      )
    ).toEqual({
      kind: 'pending',
      createdAt: at,
    });
  });

  it('shows the last outcome until an edit reopens it', () => {
    const review = { status: 'Unactioned', createdAt: at, resolvedAt: at, modComment: 'no' };
    expect(ownerRatingButtonState(review, false)).toEqual({
      kind: 'resolved',
      label: 'declined',
      resolvedAt: at,
      modComment: 'no',
    });
    expect(ownerRatingButtonState(review, true)).toEqual({ kind: 'open' });
    expect(ownerRatingButtonState({ ...review, status: 'Actioned' }, false)).toMatchObject({
      label: 'approved',
    });
  });
});
