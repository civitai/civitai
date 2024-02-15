import { createDetailFetcher } from '~/server/notifications/detail-fetchers/base.detail-fetcher';
import { modelNotifications } from '~/server/notifications/model.notifications';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import { isDefined } from '~/utils/type-guards';

export const modelDetailFetcher = createDetailFetcher({
  types: [...Object.keys(modelNotifications).filter((type) => !type.includes('milestone'))],
  fetcher: async (notifications, { db }) => {
    const modelIds = notifications
      .map((n) => n.details.modelId as number | undefined)
      .filter(isDefined);
    if (modelIds.length === 0) return;

    const models = await db.model.findMany({
      where: { id: { in: modelIds } },
      select: {
        id: true,
        name: true,
        user: { select: simpleUserSelect },
      },
    });

    for (const n of notifications) {
      const model = models.find((c) => c.id === n.details.modelId);
      if (model) {
        n.details.actor = model.user;
      }
    }
  },
});
