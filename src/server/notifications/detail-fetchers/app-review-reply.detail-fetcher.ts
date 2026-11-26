import { createDetailFetcher } from '~/server/notifications/detail-fetchers/base.detail-fetcher';
import { simpleUserSelect } from '~/server/selectors/user.selector';

/**
 * Resolves the stored `authorUserId` of a moderator's thread reply into `actor`, the moderator
 * the byline names and the notification list shows as the avatar. A deleted or missing account
 * resolves to no actor, so the byline falls back to "From Civitai App Review".
 */
export const appReviewReplyDetailFetcher = createDetailFetcher({
  types: ['app-review-reply-to-developer'],
  fetcher: async (notifications, { db }) => {
    const userIds = [
      ...new Set(
        notifications
          .map((n) => n.details.authorUserId)
          .filter((id): id is number => typeof id === 'number')
      ),
    ];
    if (userIds.length === 0) return;

    const users = await db.user.findMany({
      where: { id: { in: userIds }, deletedAt: null },
      select: simpleUserSelect,
    });

    for (const n of notifications) {
      const user = users.find((u) => u.id === n.details.authorUserId);
      if (user) n.details.actor = user;
    }
  },
});
