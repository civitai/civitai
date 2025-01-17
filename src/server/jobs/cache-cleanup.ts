import { CacheTTL } from '~/server/common/constants';
import {
  redis,
  REDIS_KEYS,
  REDIS_SYS_KEYS,
  RedisKeyTemplateCache,
  sysRedis,
} from '~/server/redis/client';
import { mergeQueue } from '~/server/redis/queues';
import { refreshBlockedModelHashes } from '~/server/services/model.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createJob } from './job';

export const cacheCleanup = createJob('cache-cleanup', '0 */1 * * *', async () => {
  // Clean rate limit keys
  const limitKeys = await redis.sMembers<RedisKeyTemplateCache>(REDIS_KEYS.TRPC.LIMIT.KEYS);
  const limitCutoff = Date.now() - CacheTTL.day * 1000;
  for (const limitKey of limitKeys) {
    const keys = await redis.packed.hGetAll<number[]>(limitKey);
    const toRemove = new Set<string>();
    for (const [key, attempts] of Object.entries(keys)) {
      const relevantAttempts = attempts.filter((x) => x > limitCutoff);
      if (relevantAttempts.length === 0) toRemove.add(key);
    }
    if (toRemove.size > 0) await redis.hDel(limitKey, [...toRemove]);
  }

  // Clean invalid token ids
  const invalidTokenIds = await sysRedis.hGetAll(REDIS_SYS_KEYS.SESSION.INVALID_TOKENS);
  const toRemove = new Set<string>();
  const tokenCutoff = Date.now() - CacheTTL.month * 1000;
  for (const [key, value] of Object.entries(invalidTokenIds)) {
    if (Number(value) < tokenCutoff) toRemove.add(key);
  }
  if (toRemove.size > 0) await sysRedis.hDel(REDIS_SYS_KEYS.SESSION.INVALID_TOKENS, [...toRemove]);

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
