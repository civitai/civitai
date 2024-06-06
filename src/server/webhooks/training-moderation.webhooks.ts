import { addToQueue, checkoutQueue } from '~/server/redis/queues';
import { createWebhookProcessor } from '~/server/webhooks/base.webhooks';

const webhookName = 'training-moderation';

export const trainingModerationWebhooks = createWebhookProcessor({
  [webhookName]: {
    displayName: 'Training Moderation',
    getData: async () => {
      const queue = await checkoutQueue(`webhooks:${webhookName}`);
      const mvIds = queue.content;
      if (!mvIds.length) return [];

      await queue.commit();

      return mvIds.map((mvId) => ({ mvId }));
    },
  },
});

export async function queueNewTrainingModerationWebhook(mvIds: number | number[]) {
  await addToQueue(`webhooks:${webhookName}`, mvIds);
}
