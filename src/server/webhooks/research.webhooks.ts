import { Prisma } from '@prisma/client';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { addToQueue, checkoutQueue } from '~/server/redis/queues';
import { calculateLevelProgression } from '~/server/utils/research-utils';
import { createWebhookProcessor } from '~/server/webhooks/base.webhooks';

type RaterWebhookData = {
  userId: number;
  username: string;
  image: string;
  count: number;
  level?: number;
};

export const researchWebhooks = createWebhookProcessor({
  'new-rater-level': {
    displayName: 'New Rater Level',
    getData: async ({ prisma }) => {
      const queue = await checkoutQueue('webhooks:new-rater-level');
      const userIds = queue.content;
      if (!userIds.length) return [];
      const results = await prisma.$queryRaw<RaterWebhookData[]>`
        SELECT
          u.id as "userId",
          u.username,
          COALESCE((
            SELECT url
            FROM "Image"
            WHERE id = u."profilePictureId"
          ), u.image) as image,
          (
            SELECT COUNT(*) as count
            FROM research_ratings
            WHERE "userId" = u.id
          ) count
        FROM "User" u
        WHERE id IN (${Prisma.join(userIds)})
      `;
      await queue.commit();

      for (const result of results) {
        result.count = Number(result.count);
        const { level } = calculateLevelProgression(result.count);
        result.level = level + 1;
        if (result.image) result.image = getEdgeUrl(result.image, { width: 96 });
      }

      return results;
    },
  },
});

export async function queueNewRaterLevelWebhook(userIds: number | number[]) {
  await addToQueue('webhooks:new-rater-level', userIds);
}
