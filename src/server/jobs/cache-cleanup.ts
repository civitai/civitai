import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { mergeQueue } from '~/server/redis/queues';
import { refreshBlockedModelHashes } from '~/server/services/model.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createJob } from './job';

export const cacheCleanup = createJob('cache-cleanup', '0 */1 * * *', async () => {
  // Note: Rate limit cleanup not needed - Redis hExpire handles TTL automatically
  // Note: Token state cleanup not needed - Redis hExpire handles TTL automatically

  // Merge queues
  const queues = await sysRedis.hGetAll(REDIS_SYS_KEYS.QUEUES.BUCKETS);
  const mergeTasks = Object.entries(queues).map(([key, buckets]) => async () => {
    if (buckets.split(',').length === 1) return;
    await mergeQueue(key);
  });
  await limitConcurrency(mergeTasks, 3);

  // Refresh materialized views
  await refreshBlockedModelHashes();
});
