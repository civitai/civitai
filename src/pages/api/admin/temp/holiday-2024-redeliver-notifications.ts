import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { NotificationCategory } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { createNotification } from '~/server/services/notification.service';
import type { Task } from '~/server/utils/concurrency-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const lightMilestones = [1, 6, 12];
export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const tasks: Task[] = [];
  const milestoneCount: Record<number, number> = {};
  for (const milestone of lightMilestones) {
    const milestoneCosmeticId = (
      await dbWrite.cosmetic.findFirst({
        where: { name: `Holiday 2024: ${milestone} lights` },
        select: { id: true },
      })
    )?.id;
    if (!milestoneCosmeticId) continue;

    const earnedBadge = await dbWrite.$queryRaw<{ userId: number }[]>`
      SELECT DISTINCT
        uc."userId"
      FROM "UserCosmetic" uc
      JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
      WHERE c.name LIKE 'Holiday Garland 2024%'
      AND (uc.data->'lights')::int >= ${milestone};
    `;
    milestoneCount[milestone] = earnedBadge.length;

    for (const { userId } of earnedBadge) {
      tasks.push(async () => {
        await createNotification({
          userId,
          key: `holiday2024:${userId}:${milestone}lights`,
          type: 'system-announcement',
          category: NotificationCategory.System,
          details: {
            message: `You've earned the ${milestone} lights badge! Claim it now.`,
            url: `/claim/cosmetic/${milestoneCosmeticId}`,
          },
        });
      });
    }
  }
  await limitConcurrency(tasks, 10);

  return res.status(200).json({ success: true, milestoneCount });
});
