import { createJob, getJobDate } from './job';
import { dbWrite } from '~/server/db/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import * as rewardImports from '~/server/rewards';
import type { BuzzEventLog } from '~/server/rewards/base.reward';
import { clickhouse } from '~/server/clickhouse/client';

const rewards = Object.values(rewardImports);
export const processRewards = createJob('rewards-process', '*/1 * * * *', async () => {
  if (!clickhouse) return;

  const [lastUpdate, setLastUpdate] = await getJobDate('process-rewards');
  const now = new Date();

  // Get all records that need to be processed, using argMax to deduplicate by version
  // This avoids needing to call OPTIMIZE TABLE which is slow
  const toProcessAll = await clickhouse.$query<BuzzEventLog>`
    SELECT
      type,
      forId,
      toUserId,
      byUserId,
      awardAmount,
      multiplier,
      status,
      ip,
      maxVersion as version,
      transactionDetails
    FROM (
      SELECT
        type,
        forId,
        toUserId,
        byUserId,
        argMax(awardAmount, version) as awardAmount,
        argMax(multiplier, version) as multiplier,
        argMax(status, version) as status,
        argMax(ip, version) as ip,
        max(version) as maxVersion,
        argMax(transactionDetails, version) as transactionDetails
      FROM buzzEvents
      WHERE time >= ${lastUpdate}
        AND time < ${now}
      GROUP BY type, forId, toUserId, byUserId
      HAVING status = 'pending'
    )
  `;

  const start = Date.now();
  for (const reward of rewards) {
    const toProcess = toProcessAll.filter((x) => reward.types.includes(x.type));
    if (!toProcess.length) continue;

    await reward.process({
      db: dbWrite,
      ch: clickhouse,
      lastUpdate,
      toProcess,
    });
  }

  setLastUpdate(now);

  return { processed: Date.now() - start };
});

export const rewardsDailyReset = createJob('rewards-daily-reset', '0 0 * * *', async () => {
  redis.del(REDIS_KEYS.BUZZ_EVENTS);
});
