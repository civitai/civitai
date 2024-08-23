import { chunk } from 'lodash-es';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { clickhouse } from '~/server/clickhouse/client';
import { NotificationCategory } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { createJob, getJobDate } from '~/server/jobs/job';
import { userMultipliersCache } from '~/server/redis/caches';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { BuzzEventsCache } from '~/server/rewards/buzz-events-cache';
import { CreateBuzzTransactionInput } from '~/server/schema/buzz.schema';
import { createNotification } from '~/server/services/notification.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

const type = 'ad-impression';
const cap = 100;
const buzzPerAd = 0.5;

export const rewardsAbusePrevention = createJob('rewards-ad-impressions', '0 * * * *', async () => {
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
      .map(({ userId, totalAdImpressions, deviceId }, i) => {
        const adImpressionAmount = Math.floor(totalAdImpressions * buzzPerAd);
        const cachedAmount = cachedAmounts[i];
        const remaining = cap - cachedAmount;
        const amount = Math.min(adImpressionAmount, remaining);

        return {
          fromAccountId: 0,
          toAccountId: userId,
          toAccountType: 'user:generation',
          amount,
          deviceId,
        };
      })
      .filter((x) => x.amount > 0);
  }

  await setLastRun();
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
};
