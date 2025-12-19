import { chunk } from 'lodash-es';
import { clickhouse } from '~/server/clickhouse/client';
import { createJob, getJobDate } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import { BuzzEventsCache } from '~/server/rewards/buzz-events-cache';
import type { CreateBuzzTransactionInput } from '~/server/schema/buzz.schema';
import { TransactionType } from '~/shared/constants/buzz.constants';
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

    // Query impressions grouped by hour to ensure proper hourly caps are applied
    // even when the job catches up on multiple hours after a failure
    const results = await clickhouse.$query<Impression>`
      SELECT
        userId,
        toStartOfHour(time) as hour,
        sum(impressions) as totalAdImpressions
      FROM adImpressions
      WHERE
        time >= toStartOfHour(${lastRun})
        AND time < toStartOfHour(now())
      GROUP BY userId, hour
      ORDER BY hour ASC;
    `;

    if (!!results?.length) {
      // Get unique users for cache lookup
      const uniqueUserIds = [...new Set(results.map(({ userId }) => userId))];

      const cachedAmounts = await BuzzEventsCache.getMany(
        uniqueUserIds.map((userId) => ({ userId, deviceId: '0', type }))
      );

      // Create a map of userId -> cached amount for quick lookup
      const cachedAmountMap = new Map(uniqueUserIds.map((userId, i) => [userId, cachedAmounts[i]]));

      // Track running totals per user to properly apply both hourly and daily caps
      const userTotals = new Map<number, number>();

      const transactions: Transaction[] = [];

      // Process each hour's impressions individually to apply per-hour caps correctly
      for (const { userId, totalAdImpressions, hour } of results) {
        const adImpressionAmount = Math.floor(totalAdImpressions * buzzPerAd);
        const cachedAmount = cachedAmountMap.get(userId) ?? 0;
        const runningTotal = userTotals.get(userId) ?? 0;

        // Calculate remaining daily cap (total cap minus already earned today minus earned in this job run)
        const remainingDailyCap = cap - cachedAmount - runningTotal;

        // Apply both hourly cap and remaining daily cap
        const amount = Math.min(adImpressionAmount, hourlyCap, remainingDailyCap);

        if (amount > 0) {
          userTotals.set(userId, runningTotal + amount);
          transactions.push({
            fromAccountId: 0,
            toAccountId: userId,
            toAccountType: 'blue',
            amount,
            type: TransactionType.Reward,
            externalTransactionId: `${userId}:${type}:${hour.getTime()}`,
          });
        }
      }

      if (transactions.length > 0) {
        const tasks = chunk(transactions, 500).map((chunk) => async () => {
          await createBuzzTransactionMany(chunk);
          await BuzzEventsCache.incrManyBy(
            chunk.map((transaction) => ({
              userId: transaction.toAccountId!,
              deviceId: '0',
              type,
              amount: transaction.amount,
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
  hour: Date;
  totalAdImpressions: number;
};

type Transaction = CreateBuzzTransactionInput & {
  fromAccountId: number;
  externalTransactionId: string;
};
