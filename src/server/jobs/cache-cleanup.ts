import { createJob } from './job';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { CacheTTL } from '~/server/common/constants';
import { mergeQueue } from '~/server/redis/queues';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import * as caches from '~/server/redis/caches';

export const cacheCleanup = createJob('cache-cleanup', '0 */1 * * *', async () => {
  // Clean rate limit keys
  const limitKeys = await redis.sMembers('trpc:limit:keys');
  const limitCutoff = Date.now() - CacheTTL.day * 1000;
  for (const limitKey of limitKeys) {
    const keys = await redis.hGetAll(limitKey);
    const toRemove = new Set<string>();
    for (const [key, attempts] of Object.entries(keys)) {
      const relevantAttempts = JSON.parse(attempts).filter((x: number) => x > limitCutoff);
      if (relevantAttempts.length === 0) toRemove.add(key);
    }
    if (toRemove.size > 0) await redis.hDel(limitKey, [...toRemove]);
  }

  // Clean invalid token ids
  const invalidTokenIds = await redis.hGetAll('session:invalid-tokens');
  const toRemove = new Set<string>();
  const tokenCutoff = Date.now() - CacheTTL.month * 1000;
  for (const [key, value] of Object.entries(invalidTokenIds)) {
    if (Number(value) < tokenCutoff) toRemove.add(key);
  }
  if (toRemove.size > 0) await redis.hDel('session:invalid-tokens', [...toRemove]);

  // Merge queues
  const queues = await redis.hGetAll(REDIS_KEYS.QUEUES.BUCKETS);
  const mergeTasks = Object.entries(queues).map(([key, buckets]) => async () => {
    if (buckets.split(',').length === 1) return;
    await mergeQueue(key);
  });
  await limitConcurrency(mergeTasks, 3);
});
