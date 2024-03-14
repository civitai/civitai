import { Prisma } from '@prisma/client';
import { createDetailFetcher } from '~/server/notifications/detail-fetchers/base.detail-fetcher';
import { SimpleUser } from '~/server/selectors/user.selector';
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
