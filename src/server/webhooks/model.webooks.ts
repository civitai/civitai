import { getAllModelsWithVersionsSelect } from '~/server/selectors/model.selector';
import { createWebhookProcessor } from '~/server/webhooks/base.webhooks';

export const modelWebhooks = createWebhookProcessor({
  'new-model': {
    displayName: 'New Models',
    getData: async ({ lastSent, prisma }) => {
      const models = await prisma.model.findMany({
        where: {
          publishedAt: {
            gt: lastSent,
          },
        },
        select: getAllModelsWithVersionsSelect,
      });

      return models;
    },
  },
});
