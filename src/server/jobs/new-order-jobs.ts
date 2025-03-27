import dayjs from 'dayjs';
import { chunk } from 'lodash-es';
import { clickhouse } from '~/server/clickhouse/client';
import { NewOrderImageRatingStatus } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { allJudmentsCounter, correctJudgementsCounter } from '~/server/games/new-order/utils';
import { createJob, getJobDate } from '~/server/jobs/job';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { TransactionType } from '~/server/schema/buzz.schema';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';
import { updatePlayerStats } from '~/server/services/games/new-order.service';

type BlessedBuzzQueryResult = {
  userId: number;
  imageId: number;
  grantedExp: number;
  multiplier: number;
};

const newOrderGrantBlessBuzz = createJob('new-order-grant-bless-buzz', '0 0 * * *', async () => {
  if (!clickhouse) return;

  const [lastRun, setLastRun] = await getJobDate('new-order-grant-bless-buzz');

  // date range is 3 days ago
  const startDate = dayjs(lastRun).subtract(3, 'day').startOf('day').toDate();
  const endDate = dayjs(lastRun).subtract(3, 'day').endOf('day').toDate();

  const correctJudgements = await clickhouse
    .query({
      query: `
        SELECT
          userId,
          imageId,
          grantedExp,
          multiplier
        FROM content_moderation_image_rating
        WHERE createdAt BETWEEN '${startDate.toISOString()}' AND '${endDate.toISOString()}'
          AND status = 'Correct'
      `,
      format: 'JSONEachRow',
    })
    .then((result) => result.json<BlessedBuzzQueryResult[]>());

  // Get current player data for knights only
  const players = await dbRead.newOrderPlayer.findMany({
    where: { userId: { in: correctJudgements.map((j) => j.userId) }, rankId: 2 }, // TODO.newOrder: better rank filtering
    select: { userId: true },
  });

  // Calculate total grantedExp for each player
  const playerExp = players.reduce((acc, player) => {
    const judgement = correctJudgements.find((j) => j.userId === player.userId);
    if (judgement) {
      // TODO.newOrder: confirm the math here
      acc[player.userId] = {
        imageId: judgement.imageId,
        buzzAmount:
          ((acc[player.userId]?.buzzAmount || 0) + judgement.grantedExp * judgement.multiplier) /
          1000,
      };
    }
    return acc;
  }, {} as Record<number, { imageId: number; buzzAmount: number }>);

  // Create buzz transactions in batches
  const userIds = Object.keys(playerExp).map(Number);
  const batches = chunk(userIds, 100);
  for (const batch of batches) {
    const transactions = batch.map((userId) => ({
      fromAccountId: 0,
      toAccountId: userId,
      amount: playerExp[userId].buzzAmount,
      type: TransactionType.Reward,
      description: 'Content Moderation Correct Judgement',
      externalTransactionId: `new-order-${userId}-${playerExp[userId].imageId}`,
    }));

    await createBuzzTransactionMany(transactions);
  }

  setLastRun();
});

type DailyResetQueryResult = {
  userId: number;
  status: NewOrderImageRatingStatus;
  grantedExp: number;
  multiplier: number;
};

const newOrderDailyReset = createJob('new-order-daily-reset', '0 0 * * *', async () => {
  if (!clickhouse) return;

  // startDate is 6 days ago
  const endDate = new Date();
  const startDate = dayjs(endDate).subtract(6, 'day').toDate();

  const judgements = await clickhouse
    .query({
      query: `
      SELECT userId, status, grantedExp, multiplier
      FROM content_moderation_image_rating
      WHERE createdAt BETWEEN '${startDate.toISOString()}' AND '${endDate.toISOString()}'
        AND status NOT IN ('AcolyteCorrect', 'AcolyteFailed')
    `,
      format: 'JSONEachRow',
    })
    .then((result) => result.json<DailyResetQueryResult[]>());

  // Clean up counters
  await Promise.all([
    correctJudgementsCounter.reset({ all: true }),
    allJudmentsCounter.reset({ all: true }),
  ]);

  const batches = chunk(judgements, 500);
  for (const batch of batches) {
    batch.forEach(async (r) => {
      await updatePlayerStats({
        playerId: r.userId,
        status: r.status,
        exp: r.grantedExp * r.multiplier,
      });
    });
  }
});

const newOrderPickTemplars = createJob('new-order-pick-templars', '0 0 * * 0', async () => {
  // TODO.newOrder: Get top 12 users from zset and assign them as templars
  const candidates = await sysRedis.zRange(REDIS_SYS_KEYS.NEW_ORDER.FERVOR, 0, 11, {
    REV: true,
  });

  // confirm where to get the data from
});

export const newOrderJobs = [newOrderGrantBlessBuzz, newOrderDailyReset, newOrderPickTemplars];
