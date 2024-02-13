import { createDetailFetcher } from '~/server/notifications/detail-fetchers/base.detail-fetcher';
import { buzzNotifications } from '~/server/notifications/buzz.notifications';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import { isDefined } from '~/utils/type-guards';

export const buzzDetailFetcher = createDetailFetcher({
  types: [...Object.keys(buzzNotifications)],
  fetcher: async (notifications, { db }) => {
    const userIds = notifications
      .map((n) => n.details.fromUserId as number | undefined)
      .filter(isDefined);
    if (userIds.length === 0) return;

    const users = await db.user.findMany({
      where: { id: { in: userIds } },
      select: simpleUserSelect,
    });

    for (const n of notifications) {
      const user = users.find((c) => c.id === n.details.fromUserId);
      if (user) {
        n.details.actor = user;
      }
    }
  },
});
