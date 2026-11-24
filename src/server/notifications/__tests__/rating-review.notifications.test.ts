import { describe, expect, it } from 'vitest';
import { buildRatingReviewNotification } from '@civitai/shared/rating-review';
import { ratingReviewNotifications } from '~/server/notifications/rating-review.notifications';

const render = (approved: boolean, modComment: string | null) => {
  const n = buildRatingReviewNotification({
    reviewId: 1,
    approved,
    entityType: 'BountyEntry',
    entityId: 3,
    parentId: 9,
    title: 'Entry #3',
    previousLevel: 8,
    appliedLevel: 2,
    modComment,
  });
  return ratingReviewNotifications[n.type].prepareMessage({ details: n.details } as never);
};

describe('rating-review notifications', () => {
  it('links the approved message to the entity page', () => {
    expect(render(true, null)).toEqual({
      message:
        'Your rating dispute on "Entry #3" was approved — the rating was updated from X to PG-13.',
      url: '/bounties/9/entries/3',
    });
  });

  it('carries the moderator reason on a rejection', () => {
    expect(render(false, 'still explicit')?.message).toBe(
      'Your rating dispute on "Entry #3" was reviewed — a moderator set the rating to PG-13. Reason: still explicit'
    );
  });

  it("names a song as the owner's song and links its page", () => {
    const song = (approved: boolean) => {
      const n = buildRatingReviewNotification({
        reviewId: 2,
        approved,
        entityType: 'Song',
        entityId: 41,
        title: 'Night drive',
        previousLevel: 8,
        appliedLevel: 4,
        modComment: null,
      });
      return ratingReviewNotifications[n.type].prepareMessage({ details: n.details } as never);
    };
    expect(song(true)).toEqual({
      message:
        'Your rating dispute on your song "Night drive" was approved — the rating was updated from X to R.',
      url: '/images/41',
    });
    expect(song(false)?.message).toBe(
      'Your rating dispute on your song "Night drive" was reviewed — a moderator set the rating to R.'
    );
  });
});
