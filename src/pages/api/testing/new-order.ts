import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { poolCounters } from '~/server/games/new-order/utils';
import { addImageToQueue, getImagesQueue } from '~/server/services/games/new-order.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';
import { commaDelimitedNumberArray } from '~/utils/zod-helpers';

const insertInQueueSchema = z.object({
  action: z.literal('insert-in-queue'),
  imageIds: commaDelimitedNumberArray(),
  rankType: z.nativeEnum({ ...NewOrderRankType, Inquisitor: 'Inquisitor' } as const),
  priority: z.coerce.number().default(1),
});
const getQueueSchema = z.object({
  action: z.literal('get-queue'),
  userId: z.coerce.number(),
});
const showAllQueuesSchema = z.object({
  action: z.literal('show-all-queues'),
  rankType: z.nativeEnum({ ...NewOrderRankType, Inquisitor: 'Inquisitor' } as const).optional(),
});

const schema = z.discriminatedUnion('action', [
  insertInQueueSchema,
  getQueueSchema,
  showAllQueuesSchema,
]);

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const payload = schema.parse(req.query);
  const { action } = payload;

  if (action === 'insert-in-queue') {
    const { imageIds, rankType, priority } = payload;

    const added = await addImageToQueue({
      imageIds,
      rankType,
      priority: priority as 1 | 2 | 3,
    });

    return res
      .status(200)
      .json({ message: added ? 'Image inserted into queue successfully' : 'bonk' });
  }

  if (action === 'get-queue') {
    const { userId } = payload;

    const queue = await getImagesQueue({
      playerId: userId,
      imageCount: 100,
    });

    return res.status(200).json(queue);
  }

  if (action === 'show-all-queues') {
    const { rankType } = payload;
    const queues = await Promise.all(
      Object.keys(NewOrderRankType)
        .filter((rank) => {
          return rankType ? rank === rankType : true;
        })
        .map(async (rank) => {
          return {
            rank,
            queues: await Promise.all(
              poolCounters[rank as NewOrderRankType].map((p) => p.getAll())
            ),
          };
        })
    );

    return res.status(200).json(queues);
  }

  return res.status(200).json({ how: 'did i get here?' });
});
