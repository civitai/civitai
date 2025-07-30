import { chunk } from 'lodash-es';
import { clickhouse } from '~/server/clickhouse/client';
import { createJob, getJobDate } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import { BuzzEventsCache } from '~/server/rewards/buzz-events-cache';
import type { CreateBuzzTransactionInput } from '~/server/schema/buzz.schema';
import { TransactionType } from '~/server/schema/buzz.schema';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

const type = 'ad-impression';
const cap = 400;
const hourlyCap = 100;
const buzzPerAd = 0.25;

export const rewardsAdImpressions = createJob('rewards-ad-impressions', '0 * * * *', async () => {
  if (!clickhouse) return;
  try {
    const defaultLastRun = new Date().getTime() - 1 * 60 * 60 * 1000;
    const [lastRun, setLastRun] = await getJobDate(
      'rewards-ad-impressions',
      new Date(defaultLastRun)
    );
    const now = new Date();
    const millisecondsSinceLastRun = now.getTime() - lastRun.getTime();
    const hours = Math.max(Math.floor((millisecondsSinceLastRun / (1000 * 60 * 60)) % 24), 1);

    const results = await clickhouse.$query<Impression>`
      SELECT
      userId,
      0 as deviceId, -- Disable deviceIds for now
      -- deviceId,
      sum(impressions) as totalAdImpressions,
      sum(duration) as totalAdDuration
      FROM adImpressions
      WHERE
        time >= toStartOfHour(${lastRun})
        AND time < toStartOfHour(now())
      GROUP BY userId, deviceId;
    `;

    if (!!results?.length) {
      const cachedAmounts = await BuzzEventsCache.getMany(
        results.map(({ userId, deviceId }) => ({ userId, deviceId, type }))
      );

      const transactions = results
        .map(({ userId, totalAdImpressions, deviceId }, i): Transaction => {
          const adImpressionAmount = Math.floor(totalAdImpressions * buzzPerAd);
          const cachedAmount = cachedAmounts[i];
          const remaining = cap - cachedAmount;
          const amount = Math.min(adImpressionAmount, remaining, hourlyCap * hours);

          return {
            fromAccountId: 0,
            toAccountId: userId,
            toAccountType: 'blue',
            amount,
            deviceId,
            type: TransactionType.Reward,
            externalTransactionId: `${userId}:${deviceId}:${type}:${lastRun.getTime()}`,
          };
        })
        .filter((x) => x.amount > 0);

      if (transactions.length > 0) {
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
    }

    await setLastRun();
  } catch (e) {
    console.error(e);
    logToAxiom({ name: 'rewards-ad-impressions', type: 'error', message: (e as any).message });
  }
});

type Impression = {
  userId: number;
  deviceId: string;
  totalAdImpressions: number;
  totalAdDuration: number;
};

type Transaction = CreateBuzzTransactionInput & {
  fromAccountId: number;
  externalTransactionId: string;
  deviceId: string;
};
