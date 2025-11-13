import dayjs from '~/shared/utils/dayjs';
import { chunk } from 'lodash-es';
import { clickhouse } from '~/server/clickhouse/client';
import { newOrderConfig } from '~/server/common/constants';
import { NewOrderImageRatingStatus, NsfwLevel } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  allJudgmentsCounter,
  blessedBuzzCounter,
  correctJudgmentsCounter,
  expCounter,
  fervorCounter,
  poolCounters,
} from '~/server/games/new-order/utils';
import { createJob } from '~/server/jobs/job';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';
import { calculateFervor, cleanseSmite } from '~/server/services/games/new-order.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';
import { createLogger } from '~/utils/logging';

const log = createLogger('new-order-jobs');

const newOrderGrantBlessedBuzz = createJob('new-order-grant-bless-buzz', '0 0 * * *', async () => {
  if (!clickhouse) return;
  log('BlessedBuzz :: Granting Blessed Buzz');

  // date range is 3 days ago
  const startDate = dayjs().subtract(3, 'day').startOf('day').toDate();
  const endDate = dayjs().subtract(3, 'day').endOf('day').toDate();

  // Get all judgments from exactly 3 days ago
  log(
    `BlessedBuzz :: Getting judgments from ${startDate.toISOString()} to ${endDate.toISOString()}`
  );
  const judgments = await clickhouse.$query<{ userId: number; balance: number; totalExp: number }>`
    SELECT
      userId,
      floor(SUM(grantedExp * multiplier) * ${newOrderConfig.blessedBuzzConversionRatio}) as balance,
      SUM(grantedExp * multiplier) as totalExp
    FROM knights_new_order_image_rating FINAL
    WHERE createdAt BETWEEN ${startDate} AND ${endDate}
      AND (status = '${NewOrderImageRatingStatus.Correct}' OR status = '${NewOrderImageRatingStatus.Failed}')
    GROUP BY userId
  `;

  if (!judgments.length) {
    log('BlessedBuzz :: No correct judgments found');
    return;
  }
  log(`BlessedBuzz :: Found ${judgments.length} correct judgments`);

  // Get current player data for knights and templars only
  const players = await dbRead.newOrderPlayer.findMany({
    where: {
      userId: { in: judgments.map((j) => j.userId) },
      rankType: { not: NewOrderRankType.Acolyte },
    },
    select: { userId: true },
  });

  const validPlayers = judgments.filter((j) => players.some((p) => p.userId === j.userId));

  if (!validPlayers.length) {
    log('BlessedBuzz :: No valid players found');
    return;
  }

  // Create buzz transactions in batches
  const batches = chunk(validPlayers, 100);
  let loopCount = 1;
  for (const batch of batches) {
    log(`BlessedBuzz :: Creating buzz transactions :: ${loopCount} of ${batches.length}`);

    const transactions = batch
      .filter((player) => player.balance > 0)
      .map((validPlayer) => ({
        fromAccountId: 0,
        toAccountId: validPlayer.userId,
        amount: validPlayer.balance,
        type: TransactionType.Reward,
        description: 'Content Moderation Correct Judgment',
        externalTransactionId: `new-order-${validPlayer.userId}-${startDate.toISOString()}`,
      }));

    if (transactions.length > 0) await createBuzzTransactionMany(transactions);

    // Deduct the actual EXP from the blessed buzz counter
    // Counter stores EXP values, not converted buzz, so we deduct totalExp
    await Promise.all(
      batch.map((player) => {
        return blessedBuzzCounter.decrement({ id: player.userId, value: player.totalExp });
      })
    );
    log(`BlessedBuzz :: Creating buzz transactions :: ${loopCount} of ${batches.length} :: done`);
    loopCount++;
  }

  log('BlessedBuzz :: Granting Blessed Buzz :: done');
});

type DailyResetQueryResult = {
  userId: number;
  exp: number;
  correctJudgments: number;
  failedJudgments: number;
  totalJudgments: number;
  fervor?: number;
};

// Updated to sync PostgreSQL from Redis counters instead of ClickHouse
// This is more efficient and respects the real-time counter updates
const newOrderDailyReset = createJob('new-order-daily-reset', '0 0 * * *', async () => {
  log('DailyReset:: Starting fervor recalculation and PostgreSQL sync');

  // Get all players to sync their stats
  const allPlayers = await dbRead.newOrderPlayer.findMany({
    select: { userId: true },
  });

  if (!allPlayers.length) {
    log('DailyReset:: No players found');
    return;
  }

  log(`DailyReset:: Processing ${allPlayers.length} players`);

  // Process in batches of 200 for optimal performance
  const batches = chunk(allPlayers, 200);
  let batchCount = 1;

  for (const batch of batches) {
    log(`DailyReset:: Processing batch ${batchCount} of ${batches.length}`);

    // Step 1: Recalculate fervor for each player using 7-day rolling window
    const playerStats = await Promise.all(
      batch.map(async (player) => {
        // Fetch 7-day judgment counts from ClickHouse (via counters)
        const [exp, correctJudgments, allJudgments, oldFervor] = await Promise.all([
          expCounter.getCount(player.userId),
          correctJudgmentsCounter.getCount(player.userId),
          allJudgmentsCounter.getCount(player.userId),
          fervorCounter.getCount(player.userId),
        ]);

        // Recalculate fervor using same formula as service
        const newFervor = calculateFervor({ correctJudgments, allJudgments });

        return {
          userId: player.userId,
          exp,
          fervor: newFervor,
          oldFervor,
          needsUpdate: newFervor !== oldFervor,
        };
      })
    );

    // Step 2: Update Redis fervor counter for players whose fervor changed
    await Promise.all(
      playerStats.map(async ({ userId, fervor, oldFervor, needsUpdate }) => {
        if (!needsUpdate) return;

        if (fervor === 0) {
          // Player has no activity in 7-day window - remove from leaderboard
          await fervorCounter.reset({ id: userId });
          log(`DailyReset:: Removed inactive player ${userId} (fervor: ${oldFervor} → 0)`);
        } else {
          // Update fervor value (reset + increment pattern)
          await fervorCounter.reset({ id: userId });
          await fervorCounter.increment({ id: userId, value: fervor });

          if (Math.abs(fervor - oldFervor) > 100) {
            log(`DailyReset:: Large fervor change for player ${userId}: ${oldFervor} → ${fervor}`);
          }
        }
      })
    );

    // Step 3: Bulk update PostgreSQL with exp and recalculated fervor
    await dbWrite.$queryRaw`
      WITH affected AS (
        SELECT
          (value ->> 'userId')::int as "userId",
          (value ->> 'exp')::int as "exp",
          (value ->> 'fervor')::int as "fervor"
        FROM json_array_elements(${JSON.stringify(playerStats)}::json)
      )
      UPDATE "NewOrderPlayer"
      SET
        "exp" = affected.exp,
        "fervor" = affected.fervor
      FROM affected
      WHERE "NewOrderPlayer"."userId" = affected."userId"
    `;

    log(`DailyReset:: Batch ${batchCount} of ${batches.length} complete`);
    batchCount++;
  }

  log(`DailyReset:: PostgreSQL sync complete - ${allPlayers.length} players updated`);
});

// Templar selection job removed as part of Knights of New Order redesign
// Templars rank has been eliminated, keeping only Acolyte and Knight ranks

// Cleanse smites that are older than 7 days
const newOrderCleanseSmites = createJob('new-order-cleanse-smites', '0 0 * * *', async () => {
  log('CleanseSmites :: Cleansing smites');
  const smites = await dbRead.newOrderSmite.findMany({
    where: { cleansedAt: null, createdAt: { lte: dayjs().subtract(7, 'days').toDate() } },
    select: { id: true, targetPlayerId: true },
  });
  if (!smites.length) {
    log('CleanseSmites :: No smites found');
    return;
  }
  log(`CleanseSmites :: Found ${smites.length} smites`);

  const cleanseTasks = smites.map((smite, index) => () => {
    log(`CleanseSmites :: Cleansing smite ${index + 1} of ${smites.length}`);

    return cleanseSmite({
      id: smite.id,
      cleansedReason: 'Smite expired',
      playerId: smite.targetPlayerId,
    });
  });

  await limitConcurrency(cleanseTasks, 5);

  log(`CleanseSmites :: Cleansing smites :: done`);
});

const ranksToClean = [NewOrderRankType.Knight, NewOrderRankType.Templar, 'Inquisitor'] as const;
const newOrderCleanupQueues = createJob('new-order-cleanup-queues', '*/10 * * * *', async () => {
  log('CleanupQueues :: Cleaning up queues');

  for (const rank of ranksToClean) {
    log(`CleanupQueues :: Cleaning up ${rank} queues`);

    // Fetch current image IDs from the rankType queue
    const currentImageIds = (
      await Promise.all(poolCounters[rank].map((pool) => pool.getAll({ limit: 10000 })))
    )
      .flat()
      .map((value) => Number(value));

    if (currentImageIds.length === 0) {
      log(`CleanupQueues :: No images found for ${rank}`);
      continue;
    }

    const chunks = chunk(currentImageIds, 1000);
    for (const chunk of chunks) {
      // Check against the database to find non-existing image IDs
      const existingImages = await dbRead.image.findMany({
        where: { id: { in: chunk } },
        select: { id: true, nsfwLevel: true },
      });
      const existingImageIds = new Set(existingImages.map((image) => image.id));
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
      await Promise.all([poolCounters[rank].map((pool) => pool.reset({ id: imageIdsToRemove }))]);
    }
  }
  log('CleanupQueues :: Cleaning up queues :: done');
});

export const newOrderJobs = [
  newOrderGrantBlessedBuzz,
  newOrderDailyReset, // Re-enabled with Redis counter sync
  newOrderCleanseSmites,
  newOrderCleanupQueues,
];
