import { createJob, getJobDate } from './job';
import { dbWrite } from '~/server/db/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import * as rewardImports from '~/server/rewards';
import type { BuzzEventLog } from '~/server/rewards/base.reward';
import { clickhouse } from '~/server/clickhouse/client';

const rewards = Object.values(rewardImports);

// An event is processed only once it is this old, so a reward that re-checks its source in
// `preprocess` (goodContent) sees a removal made shortly after the event.
export const REWARD_SETTLE_MS = 2 * 60 * 1000;

export const processRewards = createJob('rewards-process', '*/1 * * * *', async () => {
  if (!clickhouse) return;

  const [lastUpdate, setLastUpdate] = await getJobDate('process-rewards');
  const cutoff = new Date(Date.now() - REWARD_SETTLE_MS);
  // A lastUpdate past the cutoff (the first runs after the settle window shipped) is left alone:
  // moving it back would re-read events already processed.
  if (cutoff <= lastUpdate) return { processed: 0 };

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
        AND time < ${cutoff}
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

  setLastUpdate(cutoff);

  return { processed: Date.now() - start };
});

export const rewardsDailyReset = createJob('rewards-daily-reset', '0 0 * * *', async () => {
  redis.del(REDIS_KEYS.BUZZ_EVENTS);
});
