import { createDetailFetcher } from '~/server/notifications/detail-fetchers/base.detail-fetcher';
import { simpleUserSelect } from '~/server/selectors/user.selector';

/** The app-review types whose copy names the individual reviewer (`appReviewByline`). */
export const APP_REVIEW_ATTRIBUTED_TYPES = [
  'app-block-approved',
  'app-block-rejected',
  'app-listing-approved',
  'app-listing-rejected',
  // The owner's copy of a staff on-behalf submit's outcome (`app-platform-update-submit.notifications`).
  'app-platform-update-approved',
  'app-platform-update-rejected',
  // NOT `app-listing-hidden`: a takedown names the team only, so its reviewer is never resolved.
] as const;

/**
 * Resolves the stored `reviewerUserId` into `actor`, the reviewer the byline names and the
 * notification list shows as the avatar. A deleted or missing account resolves to no actor, so
 * the byline falls back to "Civitai App Review".
 */
export const appReviewDetailFetcher = createDetailFetcher({
  types: [...APP_REVIEW_ATTRIBUTED_TYPES],
  fetcher: async (notifications, { db }) => {
    const userIds = [
      ...new Set(
        notifications
          .map((n) => n.details.reviewerUserId)
          .filter((id): id is number => typeof id === 'number')
      ),
    ];
    if (userIds.length === 0) return;

    const users = await db.user.findMany({
      where: { id: { in: userIds }, deletedAt: null },
      select: simpleUserSelect,
    });

    for (const n of notifications) {
      const user = users.find((u) => u.id === n.details.reviewerUserId);
      // The byline and avatar need the name and picture only; the account id stays server-side.
      if (user) {
        const { id, ...actor } = user;
        n.details.actor = actor;
      }
    }
  },
});
