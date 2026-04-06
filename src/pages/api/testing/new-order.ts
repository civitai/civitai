import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import {
  blessedBuzzCounter,
  pendingBuzzCounter,
  correctJudgmentsCounter,
  allJudgmentsCounter,
  expCounter,
  fervorCounter,
} from '~/server/games/new-order/utils';
import { getImagesQueue } from '~/server/services/games/new-order.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { commaDelimitedNumberArray } from '~/utils/zod-helpers';
import { dbRead } from '~/server/db/client';
import { NewOrderImageRatingStatus } from '~/server/common/enums';
import { clickhouse } from '~/server/clickhouse/client';
import dayjs from 'dayjs';

const getQueueSchema = z.object({
  action: z.literal('get-queue'),
  userId: z.coerce.number(),
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
  getQueueSchema,
  getBlessedBuzzSchema,
  testBlessedBuzzSchema,
  testPendingBuzzSchema,
  testBatchCountersSchema,
  testStartAtFilteringSchema,
]);

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const payload = schema.parse(req.query);
  const { action } = payload;

  if (action === 'get-queue') {
    const { userId } = payload;

    const queue = await getImagesQueue({
      playerId: userId,
      imageCount: 100,
    });

    return res.status(200).json(queue);
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
