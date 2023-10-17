import { createJob, getJobDate } from './job';
import { dbWrite } from '~/server/db/client';
import { redis } from '~/server/redis/client';
import * as rewardImports from '~/server/rewards';
import { BuzzEventLog } from '~/server/rewards/base.reward';
import { clickhouse } from '~/server/clickhouse/client';
import dayjs from 'dayjs';

const rewards = Object.values(rewardImports);
export const processRewards = createJob('rewards-process', '*/1 * * * *', async () => {
  if (!clickhouse) return;
  const timers = {
    optimized: 0,
    processed: 0,
  };

  const [lastUpdate, setLastUpdate] = await getJobDate('process-rewards');
  const now = new Date();
  const chLastUpdate = dayjs(lastUpdate).toISOString();
  const chNow = dayjs(now).toISOString();

  timers.optimized += await mergeUniqueEvents();

  // Get all records that need to be processed
  const toProcessAll = await clickhouse
    .query({
      query: `
      SELECT
        type,
        forId,
        toUserId,
        byUserId,
        awardAmount,
        status,
        ip,
        version
      FROM buzzEvents
      WHERE status = 'pending'
        AND time >= parseDateTimeBestEffortOrNull('${chLastUpdate}')
        AND time < parseDateTimeBestEffortOrNull('${chNow}')
    `,
      format: 'JSONEachRow',
    })
    .then((x) => x.json<BuzzEventLog[]>());

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
  redis.del('buzz-events');
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
