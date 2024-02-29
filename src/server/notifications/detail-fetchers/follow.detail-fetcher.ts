import { createDetailFetcher } from '~/server/notifications/detail-fetchers/base.detail-fetcher';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import { isDefined } from '~/utils/type-guards';
import { followNotifications } from '~/server/notifications/follow.notifications';

export const followDetailFetcher = createDetailFetcher({
  types: [...Object.keys(followNotifications)],
  fetcher: async (notifications, { db }) => {
    const userIds = notifications
      .map((n) => n.details.userId as number | undefined)
      .filter(isDefined);
    if (userIds.length === 0) return;

    const users = await db.user.findMany({
      where: { id: { in: userIds } },
      select: simpleUserSelect,
    });

    for (const n of notifications) {
      const user = users.find((c) => c.id === n.details.userId);
      if (user) {
        n.details.actor = user;
      }
    }
  },
});
