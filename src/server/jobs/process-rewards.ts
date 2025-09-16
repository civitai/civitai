import { createJob, getJobDate } from './job';
import { dbWrite } from '~/server/db/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import * as rewardImports from '~/server/rewards';
import type { BuzzEventLog } from '~/server/rewards/base.reward';
import { clickhouse } from '~/server/clickhouse/client';
import dayjs from '~/shared/utils/dayjs';

const rewards = Object.values(rewardImports);
export const processRewards = createJob('rewards-process', '*/1 * * * *', async () => {
  if (!clickhouse) return;
  const timers = {
    optimized: 0,
    processed: 0,
  };

  const [lastUpdate, setLastUpdate] = await getJobDate('process-rewards');
  const now = new Date();

  timers.optimized += await mergeUniqueEvents();

  // Get all records that need to be processed
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
      version,
      transactionDetails
    FROM buzzEvents
    WHERE status = 'pending'
      AND time >= ${lastUpdate}
      AND time < ${now}
  `;

  for (const reward of rewards) {
    const toProcess = toProcessAll.filter((x) => reward.types.includes(x.type));
    if (!toProcess.length) continue;

    const start = Date.now();
    await reward.process({
      db: dbWrite,
      ch: clickhouse,
      lastUpdate,
      toProcess,
    });
    timers.processed += Date.now() - start;
    timers.optimized += await mergeUniqueEvents();
  }

  setLastUpdate(now);

  return timers;
});

export const rewardsDailyReset = createJob('rewards-daily-reset', '0 0 * * *', async () => {
  redis.del(REDIS_KEYS.BUZZ_EVENTS);
});

async function mergeUniqueEvents() {
  if (!clickhouse) return 0;

  const start = Date.now();
  try {
    await clickhouse.command({
      query: `OPTIMIZE TABLE buzzEvents`,
      clickhouse_settings: {
        wait_end_of_query: 1,
      },
    });
  } catch (e) {
    throw new Error(`Failed to optimize table: ${(e as any).message}`);
  }
  return Date.now() - start;
}
