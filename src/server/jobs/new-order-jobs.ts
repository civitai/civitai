import dayjs from 'dayjs';
import { chunk } from 'lodash-es';
import { clickhouse } from '~/server/clickhouse/client';
import { NewOrderImageRatingStatus } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  allJudmentsCounter,
  blessedBuzzCounter,
  correctJudgementsCounter,
  expCounter,
  fervorCounter,
} from '~/server/games/new-order/utils';
import { createJob } from '~/server/jobs/job';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { TransactionType } from '~/server/schema/buzz.schema';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';
import {
  calculateFervor,
  cleanseSmite,
  updatePlayerStats,
} from '~/server/services/games/new-order.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';
import { removeDuplicates } from '~/utils/array-helpers';
import { createLogger } from '~/utils/logging';

// TODO.newOrder: signals after each job?

const log = createLogger('new-order-jobs');

type BlessedBuzzQueryResult = {
  userId: number;
  imageId: number;
  grantedExp: number;
  multiplier: number;
};

const newOrderGrantBlessedBuzz = createJob('new-order-grant-bless-buzz', '0 0 * * *', async () => {
  if (!clickhouse) return;
  log('BlessedBuzz :: Granting Blessed Buzz');

  // date range is 3 days ago
  const startDate = dayjs().subtract(3, 'day').startOf('day').toDate();
  const endDate = dayjs().subtract(3, 'day').endOf('day').toDate();

  // Get all correct judgements for the last 3 days
  log(
    `BlessedBuzz :: Getting correct judgements from ${startDate.toISOString()} to ${endDate.toISOString()}`
  );
  const judgements = await clickhouse.$query<{ userId: number; balance: number }>`
        SELECT
          userId,
          SUM(exp * multiplier) as balance

        FROM newOrderImageRating
        WHERE createdAt BETWEEN '${startDate.toISOString()}' AND '${endDate.toISOString()}'
          AND (status = 'Correct' OR status = 'Failed')
      `;

  const positiveBalanceJudgements = judgements.filter((j) => j.balance > 0);

  if (!positiveBalanceJudgements.length) {
    log('BlessedBuzz :: No correct judgements found');
    return;
  }
  log(`BlessedBuzz :: Found ${positiveBalanceJudgements.length} correct judgements`);

  // Get current player data for knights and templars only
  const players = await dbRead.newOrderPlayer.findMany({
    where: {
      userId: { in: positiveBalanceJudgements.map((j) => j.userId) },
      rankType: { not: NewOrderRankType.Acolyte },
    },
    select: { userId: true },
  });

  const validPlayers = positiveBalanceJudgements.filter((j) =>
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
      description: 'Content Moderation Correct Judgement',
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
  status: NewOrderImageRatingStatus;
  grantedExp: number;
  multiplier: number;
};

const newOrderDailyReset = createJob('new-order-daily-reset', '0 0 * * *', async () => {
  if (!clickhouse) return;
  log('DailyReset:: Running daily reset');

  // startDate is 6 days ago
  const endDate = new Date();
  const startDate = dayjs(endDate).subtract(6, 'day').toDate();

  log(
    `DailyReset:: Getting judgements from ${startDate.toISOString()} to ${endDate.toISOString()}`
  );
  const judgements = await clickhouse
    .query({
      query: `
        SELECT userId, status, grantedExp, multiplier
        FROM newOrderImageRating
        WHERE createdAt BETWEEN '${startDate.toISOString()}' AND '${endDate.toISOString()}'
          AND status NOT IN ('AcolyteCorrect', 'AcolyteFailed')
      `,
      format: 'JSONEachRow',
    })
    .then((result) => result.json<DailyResetQueryResult[]>());
  if (!judgements.length) {
    log('DailyReset:: No judgements found');
    return;
  }

  // Clean up counters
  const userIds = removeDuplicates(judgements.map((j) => j.userId));
  await Promise.all([
    ...userIds.map((id) => correctJudgementsCounter.reset({ id })),
    ...userIds.map((id) => allJudmentsCounter.reset({ id })),
    ...userIds.map((id) => fervorCounter.reset({ id })),
    ...userIds.map((id) => expCounter.reset({ id })),
  ]);
  log('DailyReset:: Cleared counters');

  const batches = chunk(judgements, 500);
  let loopCount = 1;
  for (const batch of batches) {
    log(`DailyReset:: Processing judgements :: ${loopCount} of ${batches.length}`);
    // TODO.newOrder: confirm this is correct way to do it without overloading the db
    batch.forEach(async (r) => {
      await updatePlayerStats({
        playerId: r.userId,
        status: r.status,
        exp: r.grantedExp * r.multiplier,
        writeToDb: true,
      });
    });

    log(`DailyReset:: Processing judgements :: ${loopCount} of ${batches.length} :: done`);
    loopCount++;
  }

  log('DailyReset:: Processing judgements :: done');
});

const newOrderPickTemplars = createJob('new-order-pick-templars', '0 0 * * 0', async () => {
  if (!clickhouse) return;
  log('PickTemplars :: Picking templars');

  const startDate = dayjs().subtract(7, 'day').startOf('day').toDate();
  const endDate = new Date();
  const judgements = await clickhouse
    .query({
      query: `
        SELECT userId, status
        FROM newOrderImageRating
        WHERE createdAt BETWEEN '${startDate.toISOString()}' AND '${endDate.toISOString()}'
          AND status NOT IN ('AcolyteCorrect', 'AcolyteFailed')
      `,
      format: 'JSONEachRow',
    })
    .then((result) => result.json<{ userId: number; status: NewOrderImageRatingStatus }[]>());
  if (!judgements.length) {
    log('PickTemplars :: No judgements found');
    return;
  }

  const userIds = judgements.map((j) => j.userId);
  const players = await dbRead.newOrderPlayer.findMany({
    where: { userId: { in: userIds }, rankType: NewOrderRankType.Knight },
    select: { userId: true },
  });
  if (!players.length) {
    log('PickTemplars :: No players found');
    return;
  }

  // Get correct judgements and total judgements count for each player
  const playersFervor = players.reduce((acc, player) => {
    const allJudgements = judgements.filter((j) => j.userId === player.userId);
    const correctJudgements = allJudgements.filter(
      (j) => j.status === NewOrderImageRatingStatus.Correct
    );
    const totalCount = allJudgements.length;
    const correctCount = correctJudgements.length;
    const fervor = calculateFervor({ correctJudgements: correctCount, allJudgements: totalCount });

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

  const candidates = await sysRedis.zRange(REDIS_SYS_KEYS.NEW_ORDER.FERVOR, 0, 11, {
    REV: true,
  });
  console.log(`PickTemplars :: Candidates: ${candidates}`);

  const playerIds = candidates.map(Number);
  await dbWrite.newOrderPlayer.updateMany({
    where: { userId: { in: playerIds } },
    data: { rankType: NewOrderRankType.Templar },
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
