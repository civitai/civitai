import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { poolCounters } from '~/server/games/new-order/utils';
import { addImageToQueue, getImagesQueue } from '~/server/services/games/new-order.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';
import { commaDelimitedNumberArray } from '~/utils/zod-helpers';
import { dbRead } from '~/server/db/client';
import { chunk } from 'lodash-es';
import { NsfwLevel } from '~/server/common/enums';

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
const removeFromQueueSchema = z.object({
  action: z.literal('remove-from-queue'),
  limit: z.coerce.number().default(1000),
  rankType: z.nativeEnum({ ...NewOrderRankType, Inquisitor: 'Inquisitor' } as const),
});

const schema = z.discriminatedUnion('action', [
  insertInQueueSchema,
  getQueueSchema,
  showAllQueuesSchema,
  removeFromQueueSchema,
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

  if (action === 'remove-from-queue') {
    const { rankType, limit } = payload;

    // Fetch current image IDs from the rankType queue
    const currentImageIds = (
      await Promise.all(
        poolCounters[rankType as NewOrderRankType].map((pool) => pool.getAll({ limit }))
      )
    )
      .flat()
      .map((value) => Number(value));

    const chunks = chunk(currentImageIds, 1000);
    for (const chunk of chunks) {
      // Check against the database to find non-existing image IDs
      const existingImages = await dbRead.image.findMany({
        where: { id: { in: chunk } },
        select: { id: true, nsfwLevel: true },
      });
      const existingImageIds = new Set(existingImages.map((image: { id: number }) => image.id));
      const blockedImageIds = new Set(
        existingImages
          .filter((image) => image.nsfwLevel === NsfwLevel.Blocked)
          .map((image) => image.id)
      );
      const imageIdsToRemove = chunk.filter(
        (id) => !existingImageIds.has(id) || blockedImageIds.has(id)
      );
      if (imageIdsToRemove.length === 0) continue;

      // Remove non-existing images from the queue
      await Promise.all(
        poolCounters[rankType as NewOrderRankType].map((pool) =>
          pool.reset({ id: imageIdsToRemove })
        )
      );
    }

    return res.status(200).json({
      message: 'Non-existing images removed from queue successfully',
    });
  }

  return res.status(200).json({ how: 'did i get here?' });
});
