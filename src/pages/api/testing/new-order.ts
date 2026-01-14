import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import {
  poolCounters,
  blessedBuzzCounter,
  pendingBuzzCounter,
  correctJudgmentsCounter,
  allJudgmentsCounter,
  expCounter,
  fervorCounter,
  getActiveSlot,
} from '~/server/games/new-order/utils';
import { addImageToQueue, getImagesQueue } from '~/server/services/games/new-order.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';
import { commaDelimitedNumberArray } from '~/utils/zod-helpers';
import { dbRead } from '~/server/db/client';
import { chunk } from 'lodash-es';
import { NewOrderImageRatingStatus, NsfwLevel } from '~/server/common/enums';
import { clickhouse } from '~/server/clickhouse/client';
import dayjs from 'dayjs';

const insertInQueueSchema = z.object({
  action: z.literal('insert-in-queue'),
  imageIds: commaDelimitedNumberArray(),
  rankType: z.enum({ ...NewOrderRankType, Inquisitor: 'Inquisitor' } as const),
  priority: z.coerce.number().default(1),
});
const getQueueSchema = z.object({
  action: z.literal('get-queue'),
  userId: z.coerce.number(),
});
const showAllQueuesSchema = z.object({
  action: z.literal('show-all-queues'),
  rankType: z.enum({ ...NewOrderRankType, Inquisitor: 'Inquisitor' } as const).optional(),
});
const removeFromQueueSchema = z.object({
  action: z.literal('remove-from-queue'),
  limit: z.coerce.number().default(1000),
  rankType: z.enum({ ...NewOrderRankType, Inquisitor: 'Inquisitor' } as const),
});

const getBlessedBuzzSchema = z.object({
  action: z.literal('get-blessed-buzz'),
});

const testBlessedBuzzSchema = z.object({
  action: z.literal('test-blessed-buzz'),
  userId: z.coerce.number().optional(),
});

const testPendingBuzzSchema = z.object({
  action: z.literal('test-pending-buzz'),
  userId: z.coerce.number().optional(),
});

const testBatchCountersSchema = z.object({
  action: z.literal('test-batch-counters'),
  userIds: commaDelimitedNumberArray().optional(),
});

const testStartAtFilteringSchema = z.object({
  action: z.literal('test-startat-filtering'),
  userId: z.coerce.number().optional(),
});

const schema = z.discriminatedUnion('action', [
  insertInQueueSchema,
  getQueueSchema,
  showAllQueuesSchema,
  removeFromQueueSchema,
  getBlessedBuzzSchema,
  testBlessedBuzzSchema,
  testPendingBuzzSchema,
  testBatchCountersSchema,
  testStartAtFilteringSchema,
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
    const { rankType, limit } = payload;

    // Fetch current image IDs from both slots
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

      removedCount += imageIdsToRemove.length;

      // Remove from both slots
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

  if (action === 'get-blessed-buzz') {
    // Retrieve all entries with their scores
    const allEntries = await blessedBuzzCounter.getAll({ withCount: true });
    // Filter out entries with negative values
    const filtered = allEntries.filter((entry) => Number(entry.score) < 0);
    return res.status(200).json({ results: filtered });
  }

  if (action === 'test-blessed-buzz') {
    let { userId } = payload;

    // If no userId provided, fetch a random active Knight from ClickHouse
    if (!userId) {
      if (!clickhouse) {
        return res.status(503).json({ error: 'ClickHouse not available' });
      }

      const sevenDaysAgo = dayjs().subtract(7, 'days').startOf('day').toDate();
      const activeKnights = await clickhouse.$query<{ userId: number }>`
        SELECT userId
        FROM knights_new_order_image_rating
        WHERE createdAt >= ${sevenDaysAgo}
          AND rank = 'Knight'
        GROUP BY userId
        HAVING COUNT(*) >= 5
        ORDER BY COUNT(*) DESC
        LIMIT 1
      `;

      if (!activeKnights || activeKnights.length === 0) {
        return res.status(404).json({ error: 'No active Knights found in the last 7 days' });
      }

      userId = activeKnights[0].userId;
    }

    const testPlayer = await dbRead.newOrderPlayer.findUnique({
      where: { userId },
      select: { userId: true, startAt: true, exp: true },
    });

    if (!testPlayer) {
      return res.status(404).json({ error: `Player not found: ${userId}` });
    }

    const start = performance.now();
    const blessedBuzz = await blessedBuzzCounter.getCount(userId);
    const duration = performance.now() - start;

    return res.status(200).json({
      player: {
        userId: testPlayer.userId,
        startAt: testPlayer.startAt.toISOString(),
        exp: testPlayer.exp,
      },
      blessedBuzz,
      performance: `${duration.toFixed(2)}ms`,
      message: 'Blessed buzz counter test completed',
    });
  }

  if (action === 'test-pending-buzz') {
    let { userId } = payload;

    // If no userId provided, fetch a random active Knight from ClickHouse
    if (!userId) {
      if (!clickhouse) {
        return res.status(503).json({ error: 'ClickHouse not available' });
      }

      const sevenDaysAgo = dayjs().subtract(7, 'days').startOf('day').toDate();
      const activeKnights = await clickhouse.$query<{ userId: number }>`
        SELECT userId
        FROM knights_new_order_image_rating
        WHERE createdAt >= ${sevenDaysAgo}
          AND rank = 'Knight'
        GROUP BY userId
        HAVING COUNT(*) >= 5
        ORDER BY COUNT(*) DESC
        LIMIT 1
      `;

      if (!activeKnights || activeKnights.length === 0) {
        return res.status(404).json({ error: 'No active Knights found in the last 7 days' });
      }

      userId = activeKnights[0].userId;
    }

    const testPlayer = await dbRead.newOrderPlayer.findUnique({
      where: { userId },
      select: { userId: true, startAt: true, exp: true },
    });

    if (!testPlayer) {
      return res.status(404).json({ error: `Player not found: ${userId}` });
    }

    const start = performance.now();
    const pendingBuzz = await pendingBuzzCounter.getCount(userId);
    const duration = performance.now() - start;

    return res.status(200).json({
      player: {
        userId: testPlayer.userId,
        startAt: testPlayer.startAt.toISOString(),
        exp: testPlayer.exp,
      },
      pendingBuzz,
      performance: `${duration.toFixed(2)}ms`,
      message: 'Pending buzz counter test completed',
    });
  }

  if (action === 'test-batch-counters') {
    let { userIds } = payload;

    // If no userIds provided, fetch active Knights from ClickHouse
    if (!userIds || userIds.length === 0) {
      if (!clickhouse) {
        return res.status(503).json({ error: 'ClickHouse not available' });
      }

      // Find active Knights with ratings in the last 7 days
      const sevenDaysAgo = dayjs().subtract(7, 'days').startOf('day').toDate();
      const activeUserIds = await clickhouse.$query<{ userId: number; ratingCount: number }>`
        SELECT
          userId,
          COUNT(*) as ratingCount
        FROM knights_new_order_image_rating
        WHERE createdAt >= ${sevenDaysAgo}
          AND rank = 'Knight'
        GROUP BY userId
        HAVING ratingCount >= 5
        ORDER BY ratingCount DESC
        LIMIT 10
      `;

      if (!activeUserIds || activeUserIds.length === 0) {
        return res.status(404).json({ error: 'No active Knights found in the last 7 days' });
      }

      // Verify these users exist in NewOrderPlayer table
      const activePlayers = await dbRead.newOrderPlayer.findMany({
        where: {
          userId: {
            in: activeUserIds.map((u) => u.userId),
          },
        },
        select: { userId: true },
      });

      if (activePlayers.length === 0) {
        return res.status(404).json({ error: 'No active Knights found in NewOrderPlayer table' });
      }

      userIds = activePlayers.map((p) => p.userId);
    }

    // Get player info for the selected users
    const playerInfo = await dbRead.newOrderPlayer.findMany({
      where: {
        userId: {
          in: userIds,
        },
      },
      select: {
        userId: true,
        startAt: true,
        exp: true,
        fervor: true,
      },
    });

    const start = performance.now();

    // Simulate daily reset job pattern - fetch 4 counters in parallel
    const [correctCounts, allCounts, expCounts, fervorCounts] = await Promise.all([
      correctJudgmentsCounter.getCountBatch(userIds),
      allJudgmentsCounter.getCountBatch(userIds),
      expCounter.getCountBatch(userIds),
      fervorCounter.getCountBatch(userIds),
    ]);

    const duration = performance.now() - start;

    // Also test blessed buzz batch
    const batchStart = performance.now();
    const blessedBuzzBatch = await blessedBuzzCounter.getCountBatch(userIds);
    const batchDuration = performance.now() - batchStart;

    return res.status(200).json({
      testInfo: {
        userIds,
        userCount: userIds.length,
        players: playerInfo.map((p) => ({
          userId: p.userId,
          startAt: p.startAt.toISOString(),
          exp: p.exp,
          fervor: p.fervor,
        })),
      },
      dailyResetPattern: {
        correctJudgments: Object.fromEntries(correctCounts),
        allJudgments: Object.fromEntries(allCounts),
        exp: Object.fromEntries(expCounts),
        fervor: Object.fromEntries(fervorCounts),
        performance: `${duration.toFixed(2)}ms`,
        perUserAverage: `${(duration / userIds.length).toFixed(2)}ms`,
      },
      blessedBuzzBatch: {
        results: Object.fromEntries(blessedBuzzBatch),
        performance: `${batchDuration.toFixed(2)}ms`,
      },
      message:
        'Batch counter test completed with active Knights (simulates daily reset job pattern)',
    });
  }

  if (action === 'test-startat-filtering') {
    let { userId } = payload;

    // If no userId provided, fetch a random active Knight from ClickHouse
    if (!userId) {
      if (!clickhouse) {
        return res.status(503).json({ error: 'ClickHouse not available' });
      }

      const sevenDaysAgo = dayjs().subtract(7, 'days').startOf('day').toDate();
      const activeKnights = await clickhouse.$query<{ userId: number }>`
        SELECT userId
        FROM knights_new_order_image_rating
        WHERE createdAt >= ${sevenDaysAgo}
          AND rank = 'Knight'
        GROUP BY userId
        HAVING COUNT(*) >= 5
        ORDER BY COUNT(*) DESC
        LIMIT 1
      `;

      if (!activeKnights || activeKnights.length === 0) {
        return res.status(404).json({ error: 'No active Knights found in the last 7 days' });
      }

      userId = activeKnights[0].userId;
    }

    const testPlayer = await dbRead.newOrderPlayer.findUnique({
      where: { userId },
      select: { userId: true, startAt: true, exp: true },
    });

    if (!testPlayer) {
      return res.status(404).json({ error: `Player not found: ${userId}` });
    }

    if (!clickhouse) {
      return res.status(503).json({ error: 'ClickHouse not available' });
    }

    const threeDaysAgo = dayjs().subtract(3, 'days').startOf('day').toDate();
    const now = dayjs().endOf('day').toDate();

    // Query WITHOUT startAt filtering (OLD BEHAVIOR)
    const allRatings = await clickhouse.$query<{
      count: number;
      totalExp: number;
    }>`
      SELECT
        COUNT(*) as count,
        SUM(grantedExp * multiplier) as totalExp
      FROM knights_new_order_image_rating
      WHERE userId = ${testPlayer.userId}
        AND createdAt BETWEEN ${threeDaysAgo} AND ${now}
        AND rank = 'Knight'
        AND status IN ('${NewOrderImageRatingStatus.Correct}', '${NewOrderImageRatingStatus.Failed}')
    `;

    // Query WITH startAt filtering (NEW BEHAVIOR)
    const filteredRatings = await clickhouse.$query<{
      count: number;
      totalExp: number;
    }>`
      SELECT
        COUNT(*) as count,
        SUM(
          CASE
            WHEN createdAt >= parseDateTimeBestEffort('${testPlayer.startAt.toISOString()}')
              THEN grantedExp * multiplier
            ELSE 0
          END
        ) as totalExp
      FROM knights_new_order_image_rating
      WHERE userId = ${testPlayer.userId}
        AND createdAt BETWEEN ${threeDaysAgo} AND ${now}
        AND rank = 'Knight'
        AND status IN ('${NewOrderImageRatingStatus.Correct}', '${
      NewOrderImageRatingStatus.Failed
    }')
    `;

    const difference = (allRatings[0]?.totalExp || 0) - (filteredRatings[0]?.totalExp || 0);

    return res.status(200).json({
      player: {
        userId: testPlayer.userId,
        startAt: testPlayer.startAt.toISOString(),
        exp: testPlayer.exp,
      },
      queryWindow: {
        from: threeDaysAgo.toISOString(),
        to: now.toISOString(),
      },
      results: {
        unfiltered: {
          count: allRatings[0]?.count || 0,
          totalExp: allRatings[0]?.totalExp || 0,
          description: 'OLD BEHAVIOR: All ratings in window',
        },
        filtered: {
          count: filteredRatings[0]?.count || 0,
          totalExp: filteredRatings[0]?.totalExp || 0,
          description: 'NEW BEHAVIOR: Only ratings after player.startAt',
        },
        difference: {
          exp: difference,
          message:
            difference > 0
              ? `Filter working: ${difference} exp from pre-reset ratings excluded`
              : "No pre-reset ratings found (player hasn't reset career)",
        },
      },
      message: 'StartAt filtering comparison completed',
    });
  }

  return res.status(200).json({ how: 'did i get here?' });
});
