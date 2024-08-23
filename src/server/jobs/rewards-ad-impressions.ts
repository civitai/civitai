import { chunk } from 'lodash-es';
import { clickhouse } from '~/server/clickhouse/client';
import { createJob, getJobDate } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import { BuzzEventsCache } from '~/server/rewards/buzz-events-cache';
import { CreateBuzzTransactionInput, TransactionType } from '~/server/schema/buzz.schema';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

const type = 'ad-impression';
const cap = 100;
const hourlyCap = 15;
const buzzPerAd = 0.5;

export const rewardsAbusePrevention = createJob('rewards-ad-impressions', '0 * * * *', async () => {
  try {
    const [lastRun, setLastRun] = await getJobDate('rewards-ad-impressions', new Date('8/22/2024'));

    const results = await clickhouse?.$query<Impression>(`
    SELECT
    userId,
    deviceId,
    count(distinct adId) AS uniqueAdImpressions,
    count() as totalAdImpressions,
    sum(duration) as totalAdDuration
    FROM adImpressions
    WHERE time > ${lastRun.getTime()}
    GROUP BY userId, deviceId;
  `);

    if (results) {
      const cachedAmounts = await BuzzEventsCache.getMany(
        results.map(({ userId, deviceId }) => ({ userId, deviceId, type }))
      );

      const transactions = results
        .map(({ userId, totalAdImpressions, deviceId }, i): Transaction => {
          const adImpressionAmount = Math.floor(totalAdImpressions * buzzPerAd);
          const cachedAmount = cachedAmounts[i];
          const remaining = cap - cachedAmount;
          const amount = Math.min(adImpressionAmount, remaining, hourlyCap);

          return {
            fromAccountId: 0,
            toAccountId: userId,
            toAccountType: 'user:generation',
            amount,
            deviceId,
            type: TransactionType.Reward,
            externalTransactionId: `${userId}:${deviceId}:${type}:${lastRun.getTime()}`,
          };
        })
        .filter((x) => x.amount > 0);

      const tasks = chunk(transactions, 500).map((chunk) => async () => {
        await createBuzzTransactionMany(chunk);
        await BuzzEventsCache.incrManyBy(
          chunk.map((transaction) => ({
            ...transaction,
            type,
            userId: transaction.toAccountId!,
          }))
        );
      });

      await limitConcurrency(tasks, 3);
    }

    await setLastRun();
  } catch (e) {
    logToAxiom({ name: 'rewards-ad-impressions', type: 'error', message: (e as any).message });
  }
});

type Impression = {
  userId: number;
  deviceId: string;
  uniqueAdImpressions: number;
  totalAdImpressions: number;
  totalAdDuration: number;
};

type Transaction = CreateBuzzTransactionInput & {
  fromAccountId: number;
  externalTransactionId: string;
  deviceId: string;
};
