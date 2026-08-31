import { Prisma } from '@prisma/client';
import { createDetailFetcher } from '~/server/notifications/detail-fetchers/base.detail-fetcher';
import type { SimpleUser } from '~/server/selectors/user.selector';
import { getProfilePicturesForUsers } from '~/server/services/user.service';
import { isDefined } from '~/utils/type-guards';

export const reviewDetailFetcher = createDetailFetcher({
  types: ['new-review'],
  fetcher: async (notifications, { db }) => {
    const reviewIds = notifications
      .map((n) => n.details.reviewId as number | undefined)
      .filter(isDefined);
    if (reviewIds.length === 0) return;

    const reviews = await db.$queryRaw<(SimpleUser & { reviewId: number; details: string })[]>`
      SELECT
        r."id" as "reviewId",
        u.id,
        u.username,
        u."deletedAt",
        u.image,
        r.details
      FROM "ResourceReview" r
      JOIN "User" u ON r."userId" = u.id
      WHERE r.id IN (${Prisma.join(reviewIds)})
        -- Same reason as the comment fetcher: this inlines the body at READ time, so a review a
        -- moderator has taken down otherwise keeps serving it into the recipient's panel.
        AND r."tosViolation" = false
    `;
    const userIds = reviews.map((u) => u.id);
    const profilePictures = await getProfilePicturesForUsers(userIds);
    for (const u of reviews) u.profilePicture = profilePictures[u.id];

    for (const n of notifications) {
      const review = reviews.find((c) => c.reviewId === n.details.reviewId);
      if (review) {
        n.details.content = review.details;
        n.details.actor = review;
      }
    }
  },
});
