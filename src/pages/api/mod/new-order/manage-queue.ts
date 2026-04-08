import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { chunk } from 'lodash-es';
import { poolCounters, getActiveSlot } from '~/server/games/new-order/utils';
import { addImageToQueue } from '~/server/services/games/new-order.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';
import { commaDelimitedNumberArray } from '~/utils/zod-helpers';
import { dbRead } from '~/server/db/client';
import { NsfwLevel } from '~/server/common/enums';

const insertInQueueSchema = z.object({
  action: z.literal('insert-in-queue'),
  imageIds: commaDelimitedNumberArray(),
  rankType: z.enum({ ...NewOrderRankType, Inquisitor: 'Inquisitor' } as const),
  priority: z.coerce.number().default(1),
});

const showAllQueuesSchema = z.object({
  action: z.literal('show-all-queues'),
  rankType: z.enum({ ...NewOrderRankType, Inquisitor: 'Inquisitor' } as const).optional(),
});

const removeFromQueueSchema = z.object({
  action: z.literal('remove-from-queue'),
  imageIds: commaDelimitedNumberArray().optional(),
  limit: z.coerce.number().default(1000),
  rankType: z.enum({ ...NewOrderRankType, Inquisitor: 'Inquisitor' } as const),
});

const schema = z.discriminatedUnion('action', [
  insertInQueueSchema,
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

  if (action === 'show-all-queues') {
    const { rankType } = payload;
    const queues = await Promise.all(
      Object.keys(NewOrderRankType)
        .filter((rank) => {
          return rankType ? rank === rankType : true;
        })
        .map(async (rank) => {
          const rankKey = rank as NewOrderRankType;

          // Get both slots for this rank
          const slotAQueues = await Promise.all(poolCounters[rankKey].a.map((p) => p.getAll()));
          const slotBQueues = await Promise.all(poolCounters[rankKey].b.map((p) => p.getAll()));

          // Get active slot pointers
          const fillingSlot = await getActiveSlot(rankKey, 'filling');
          const ratingSlot = await getActiveSlot(rankKey, 'rating');

          return {
            rank,
            activeSlots: {
              filling: fillingSlot,
              rating: ratingSlot,
            },
            slots: {
              a: slotAQueues,
              b: slotBQueues,
            },
          };
        })
    );

    return res.status(200).json(queues);
  }

  if (action === 'remove-from-queue') {
    const { rankType, limit, imageIds } = payload;

    // If specific imageIds provided, remove them directly
    if (imageIds && imageIds.length > 0) {
      await Promise.all([
        ...poolCounters[rankType as NewOrderRankType].a.map((pool) => pool.reset({ id: imageIds })),
        ...poolCounters[rankType as NewOrderRankType].b.map((pool) => pool.reset({ id: imageIds })),
      ]);

      return res.status(200).json({
        message: `Removed ${imageIds.length} image(s) from ${rankType} queue`,
        removedCount: imageIds.length,
        imageIds,
      });
    }

    // Otherwise, scan and remove non-existing/blocked images
    const slotAImageIds = (
      await Promise.all(
        poolCounters[rankType as NewOrderRankType].a.map((pool) => pool.getAll({ limit }))
      )
    )
      .flat()
      .map((value) => Number(value));

    const slotBImageIds = (
      await Promise.all(
        poolCounters[rankType as NewOrderRankType].b.map((pool) => pool.getAll({ limit }))
      )
    )
      .flat()
      .map((value) => Number(value));

    const currentImageIds = [...slotAImageIds, ...slotBImageIds];

    const chunks = chunk(currentImageIds, 1000);
    let removedCount = 0;

    for (const chunk of chunks) {
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

      removedCount += imageIdsToRemove.length;

      await Promise.all([
        ...poolCounters[rankType as NewOrderRankType].a.map((pool) =>
          pool.reset({ id: imageIdsToRemove })
        ),
        ...poolCounters[rankType as NewOrderRankType].b.map((pool) =>
          pool.reset({ id: imageIdsToRemove })
        ),
      ]);
    }

    return res.status(200).json({
      message: 'Non-existing images removed from queue successfully',
      removedCount,
      checkedSlots: ['a', 'b'],
    });
  }

  return res.status(400).json({ error: 'Unknown action' });
});
