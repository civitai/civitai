import { removeDuplicates } from '@tiptap/react';
import dayjs from 'dayjs';
import { chunk } from 'lodash-es';
import { clickhouse } from '~/server/clickhouse/client';
import { newOrderConfig } from '~/server/common/constants';
import { NewOrderImageRatingStatus } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  allJudgmentsCounter,
  blessedBuzzCounter,
  correctJudgmentsCounter,
  expCounter,
  fervorCounter,
} from '~/server/games/new-order/utils';
import { createJob } from '~/server/jobs/job';
import { TransactionType } from '~/server/schema/buzz.schema';
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

  // Get all correct judgments for the last 3 days
  log(
    `BlessedBuzz :: Getting correct judgments from ${startDate.toISOString()} to ${endDate.toISOString()}`
  );
  const judgments = await clickhouse.$query<{ userId: number; balance: number }>`
    SELECT
      userId,
      floor(SUM(grantedExp * multiplier) * ${newOrderConfig.blessedBuzzConversionRatio}) as balance
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
    log(`BlessedBuzz :: Creating buzz transactions :: ${loopCount} of ${batches.length} :: done`);
    loopCount++;
  }

  await Promise.all(validPlayers.map(({ userId: id }) => blessedBuzzCounter.reset({ id })));

  log('BlessedBuzz :: Granting Blessed Buzz :: done');
});

type DailyResetQueryResult = {
  userId: number;
  exp: number;
  correctJudgments: number;
  failedJudgments: number;
  totalJudgments: number;
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

  const json = users.map((u) => `'${JSON.stringify(u)}'`);
  const userData = await clickhouse.$query<DailyResetQueryResult>`
    WITH u AS (
      SELECT 
        arrayJoin([${json}]) as user,
        JSONExtractInt(user, 'userId') as userId,
        JSONExtractString(user, 'startAt') as startAt
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
        if (knoir."createdAt" > parseDateTimeBestEffort(u.startAt) AND knoir."status" NOT IN ('${NewOrderImageRatingStatus.AcolyteCorrect}', '${NewOrderImageRatingStatus.AcolyteFailed}'), 1, 0)
      ) as totalJudgments
    FROM knights_new_order_image_rating knoir
    JOIN u ON knoir."userId" = CAST(u.userId as Int32)
    WHERE knoir."createdAt" BETWEEN ${startDate} AND ${endDate}
    GROUP BY knoir."userId"
  `;

  if (!userData.length) {
    log('DailyReset:: No judgments found');
    return;
  }

  const batches = chunk(userData, 500);
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

  // Clean up counters
  const userIds = userData.map((j) => j.userId);
  await Promise.all([
    ...userIds.map((id) => correctJudgmentsCounter.reset({ id })),
    ...userIds.map((id) => allJudgmentsCounter.reset({ id })),
    ...userIds.map((id) => fervorCounter.reset({ id })),
    ...userIds.map((id) => expCounter.reset({ id })),
  ]);
  log('DailyReset:: Cleared counters');
});

const newOrderPickTemplars = createJob('new-order-pick-templars', '0 0 * * 0', async () => {
  if (!clickhouse) return;
  log('PickTemplars :: Picking templars');

  const startDate = dayjs().subtract(7, 'day').startOf('day').toDate();
  const endDate = new Date();
  const judgments = await clickhouse.$query<{ userId: number; status: NewOrderImageRatingStatus }>`
    SELECT userId, status
    FROM knights_new_order_image_rating
    WHERE createdAt BETWEEN ${startDate} AND ${endDate}
      AND status NOT IN ('${NewOrderImageRatingStatus.AcolyteCorrect}', '${NewOrderImageRatingStatus.AcolyteFailed}')
  `;

  if (!judgments.length) {
    log('PickTemplars :: No judgments found');
    return;
  }

  const userIds = removeDuplicates(judgments.map((j) => j.userId));
  const players = await dbRead.newOrderPlayer.findMany({
    where: {
      userId: { in: userIds },
      rankType: {
        in: [NewOrderRankType.Knight, NewOrderRankType.Templar],
      },
    },
    select: { userId: true },
  });

  if (!players.length) {
    log('PickTemplars :: No players found');
    return;
  }

  // Get correct judgments and total judgments count for each player
  const playersFervor = players.reduce((acc, player) => {
    const allJudgments = judgments.filter((j) => j.userId === player.userId);
    const correctJudgments = allJudgments.filter(
      (j) => j.status === NewOrderImageRatingStatus.Correct
    );
    const totalCount = allJudgments.length;
    const correctCount = correctJudgments.length;
    const fervor = calculateFervor({ correctJudgments: correctCount, allJudgments: totalCount });

    acc[player.userId] = fervor;

    return acc;
  }, {} as Record<number, number>);

  // Clear fervor counters
  await Promise.all(
    Object.keys(playersFervor).map((id) => fervorCounter.reset({ id: Number(id) }))
  );

  // Update fervor counter with new data
  await Promise.all(
    Object.entries(playersFervor).map(([id, fervor]) =>
      fervorCounter.increment({ id: Number(id), value: fervor })
    )
  );

  const candidates = await fervorCounter.getAll({ limit: 12 });

  log(`PickTemplars :: Candidates: ${candidates}`);

  const playerIds = candidates.map(Number);
  // Update the new templars:
  await dbWrite.newOrderPlayer.updateMany({
    where: { userId: { in: playerIds }, rankType: NewOrderRankType.Knight },
    data: { rankType: NewOrderRankType.Templar },
  });

  // Update the new knights:
  await dbWrite.newOrderPlayer.updateMany({
    where: {
      userId: { in: players.filter((p) => !playerIds.includes(p.userId)).map((p) => p.userId) },
      rankType: { not: NewOrderRankType.Acolyte },
    },
    data: { rankType: NewOrderRankType.Knight },
  });

  log('PickTemplars :: Picking templars :: done');
});

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

export const newOrderJobs = [
  newOrderGrantBlessedBuzz,
  newOrderDailyReset,
  newOrderPickTemplars,
  newOrderCleanseSmites,
];
