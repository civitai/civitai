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
    FROM knights_new_order_image_rating
    WHERE createdAt BETWEEN ${startDate} AND ${endDate}
      AND (status = '${NewOrderImageRatingStatus.Correct}' OR status = '${NewOrderImageRatingStatus.Failed}')
    GROUP BY userId
    HAVING balance > 0
  `;

  const positiveBalanceJudgments = judgments.filter((j) => j.balance > 0);

  if (!positiveBalanceJudgments.length) {
    log('BlessedBuzz :: No correct judgments found');
    return;
  }
  log(`BlessedBuzz :: Found ${positiveBalanceJudgments.length} correct judgments`);

  // Get current player data for knights and templars only
  const players = await dbRead.newOrderPlayer.findMany({
    where: {
      userId: { in: positiveBalanceJudgments.map((j) => j.userId) },
      rankType: { not: NewOrderRankType.Acolyte },
    },
    select: { userId: true },
  });

  const validPlayers = positiveBalanceJudgments.filter((j) =>
    players.some((p) => p.userId === j.userId)
  );

  if (!validPlayers.length) {
    log('BlessedBuzz :: No valid players found');
    return;
  }

  // Create buzz transactions in batches
  const batches = chunk(validPlayers, 100);
  let loopCount = 1;
  for (const batch of batches) {
    log(`BlessedBuzz :: Creating buzz transactions :: ${loopCount} of ${batches.length}`);
    const transactions = batch.map((validPlayer) => ({
      fromAccountId: 0,
      toAccountId: validPlayer.userId,
      amount: validPlayer.balance,
      type: TransactionType.Reward,
      description: 'Content Moderation Correct Judgment',
      externalTransactionId: `new-order-${validPlayer.userId}-${startDate.toISOString()}`,
    }));

    await createBuzzTransactionMany(transactions);

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

const newOrderDailyReset = createJob('new-order-daily-reset', '0 0 * * *', async () => {
  if (!clickhouse) return;
  log('DailyReset:: Running daily reset');

  const endDate = new Date();
  // Apr. 10, 2025 as Start Date
  const startDate = dayjs('2025-04-10').startOf('day').toDate();

  log(`DailyReset:: Getting judgments from ${startDate.toISOString()} to ${endDate.toISOString()}`);

  const users = await dbRead.newOrderPlayer.findMany({
    select: { userId: true, startAt: true },
  });

  if (!users.length) {
    log('DailyReset:: No users found');
    return;
  }

  const userBatches = chunk(users, 1000);
  log(`DailyReset:: Processing ${users.length} users in ${userBatches.length} batches`);
  let userData: DailyResetQueryResult[] = [];
  let userLoopCount = 1;
  for (const batch of userBatches) {
    log(`DailyReset:: Processing users :: ${userLoopCount} of ${userBatches.length}`);

    const tuples = batch.map((u) => `(${u.userId},'${u.startAt.toISOString()}')`).join(',');
    const data = await clickhouse.$query<DailyResetQueryResult>`
    WITH u AS (
      SELECT
        arrayJoin([${tuples}]) as user_tuple,
        user_tuple.1 as userId,
        user_tuple.2 as startAt
    )
    SELECT
      knoir."userId",
      SUM(
        -- Make it so we ignore elements before a reset.
        if (knoir."createdAt" > parseDateTimeBestEffort(u.startAt), 1, 0) *
        grantedExp * multiplier
      ) as exp,
      SUM(
        -- Make it so we ignore elements before a reset.
        if (knoir."createdAt" > parseDateTimeBestEffort(u.startAt) AND knoir."status" = '${NewOrderImageRatingStatus.Correct}', 1, 0)
      ) as correctJudgments,
      SUM(
        -- Make it so we ignore elements before a reset.
        if (knoir."createdAt" > parseDateTimeBestEffort(u.startAt) AND knoir."status" = '${NewOrderImageRatingStatus.Failed}', 1, 0)
      ) as failedJudgments,
      SUM(
        -- Make it so we ignore elements before a reset.
        -- Exclude 'AcolyteCorrect' and 'AcolyteFailed' statuses from total judgments as they represent auxiliary actions not directly tied to the primary judgment process.
        if (knoir."createdAt" > parseDateTimeBestEffort(u.startAt) AND knoir."status" IN ('${NewOrderImageRatingStatus.Correct}', '${NewOrderImageRatingStatus.Failed}'), 1, 0)
      ) as totalJudgments
    FROM knights_new_order_image_rating knoir
    JOIN u ON knoir."userId" = CAST(u.userId as Int32)
    WHERE knoir."createdAt" BETWEEN ${startDate} AND ${endDate}
    GROUP BY knoir."userId"
  `;

    if (data.length) {
      userData = [...userData, ...data];
    }

    log(`DailyReset:: Processing users :: ${userLoopCount} of ${userBatches.length} :: done`);
    userLoopCount++;
  }

  if (!userData.length) {
    log('DailyReset:: No judgments found');
    return;
  }

  const batches = chunk(userData, 200);
  let loopCount = 1;
  for (const batch of batches) {
    log(`DailyReset:: Processing judgments :: ${loopCount} of ${batches.length}`);
    const batchWithFervor = batch.map((b) => ({
      ...b,
      fervor: calculateFervor({
        correctJudgments: b.correctJudgments,
        allJudgments: b.totalJudgments,
      }),
    }));

    await dbWrite.$queryRaw`
      WITH affected AS (
        SELECT
          (value ->> 'userId')::int as "userId",
          (value ->> 'exp')::int as "exp",
          (value ->> 'fervor')::int as "fervor"
        FROM json_array_elements(${JSON.stringify(batchWithFervor)}::json)
      )
      UPDATE "NewOrderPlayer"
      SET
        "exp" = affected.exp,
        "fervor" = affected.fervor
      FROM affected
      WHERE "NewOrderPlayer"."userId" = affected."userId"
    `;

    log(`DailyReset:: Processing judgments :: ${loopCount} of ${batches.length} :: done`);
    loopCount++;
  }
  log('DailyReset:: Processing judgments :: done');

  // Synchronize Redis counters with PostgreSQL values
  // This ensures Redis and DB stay in sync and prevents race conditions
  log('DailyReset:: Synchronizing Redis counters with DB values');
  const syncBatches = chunk(userData, 100);
  let syncLoopCount = 1;
  for (const syncBatch of syncBatches) {
    log(`DailyReset:: Synchronizing counters :: ${syncLoopCount} of ${syncBatches.length}`);

    await Promise.all(
      syncBatch.flatMap((user) => [
        // Reset and repopulate exp counter
        (async () => {
          await expCounter.reset({ id: user.userId });
          if (user.exp > 0) await expCounter.increment({ id: user.userId, value: user.exp });
        })(),
        // Reset and repopulate fervor counter
        (async () => {
          await fervorCounter.reset({ id: user.userId });
          if (user.fervor && user.fervor > 0)
            await fervorCounter.increment({ id: user.userId, value: user.fervor });
        })(),
        // Reset judgment counters (these will repopulate from ClickHouse on next access)
        correctJudgmentsCounter.reset({ id: user.userId }),
        allJudgmentsCounter.reset({ id: user.userId }),
      ])
    );

    log(`DailyReset:: Synchronizing counters :: ${syncLoopCount} of ${syncBatches.length} :: done`);
    syncLoopCount++;
  }
  log('DailyReset:: Synchronized Redis counters with DB values');
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
  newOrderDailyReset,
  // newOrderPickTemplars removed - Templar rank eliminated in redesign
  newOrderCleanseSmites,
  newOrderCleanupQueues,
];
