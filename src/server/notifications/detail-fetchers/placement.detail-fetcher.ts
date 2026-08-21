import { createDetailFetcher } from '~/server/notifications/detail-fetchers/base.detail-fetcher';
import { placementNotifications } from '~/server/notifications/placement.notifications';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import { isDefined } from '~/utils/type-guards';

/**
 * The other party to the placement, whoever the reader is not.
 *
 * A pending type is addressed to the owner and names the placer; a resolved one
 * is addressed to the placer and names the owner. Both are written by the
 * processor, so this picks whichever is there rather than branching on the type.
 */
const counterpartyId = (details: Record<string, unknown>) =>
  (details.placerId ?? details.ownerId) as number | undefined;

export const placementDetailFetcher = createDetailFetcher({
  types: [...Object.keys(placementNotifications)],
  fetcher: async (notifications, { db }) => {
    const userIds = [
      ...new Set(notifications.map((n) => counterpartyId(n.details)).filter(isDefined)),
    ];
    if (!userIds.length) return;

    const users = await db.user.findMany({
      where: { id: { in: userIds } },
      select: simpleUserSelect,
    });

    for (const n of notifications) {
      const user = users.find((u) => u.id === counterpartyId(n.details));
      if (user) n.details.actor = user;
    }
  },
});
