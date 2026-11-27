import { createDetailFetcher } from '~/server/notifications/detail-fetchers/base.detail-fetcher';
import { simpleUserSelect } from '~/server/selectors/user.selector';

/** The app-review types whose copy names the individual reviewer (`appReviewByline`). */
export const APP_REVIEW_ATTRIBUTED_TYPES = [
  'app-block-approved',
  'app-block-rejected',
  'app-listing-approved',
  'app-listing-rejected',
  // NOT `app-listing-hidden`: a takedown names the team only, so its reviewer is never resolved.
] as const;

/**
 * Resolves the stored `reviewerUserId` into `actor`, the reviewer the byline names and the
 * notification list shows as the avatar. A deleted or missing account resolves to no actor, so
 * the byline falls back to "Civitai App Review".
 *
 * The details this returns go to the client verbatim (the notification list and
 * `/api/notification/getDetails`), so the stored id is removed from every notification in the
 * batch, resolved or not, and replaced by `reviewedByModerator`, which is all the byline needs to
 * fall back to the team when there is no actor.
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

    const users =
      userIds.length === 0
        ? []
        : await db.user.findMany({
            where: { id: { in: userIds }, deletedAt: null },
            select: simpleUserSelect,
          });

    for (const n of notifications) {
      const reviewerUserId = n.details.reviewerUserId;
      if (typeof reviewerUserId === 'number') {
        const user = users.find((u) => u.id === reviewerUserId);
        if (user) {
          const { id, ...actor } = user;
          n.details.actor = actor;
        }
        n.details.reviewedByModerator = true;
      }
      delete n.details.reviewerUserId;
    }
  },
});
