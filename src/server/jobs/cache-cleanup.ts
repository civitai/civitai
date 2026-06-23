import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { mergeQueue } from '~/server/redis/queues';
import { refreshBlockedModelHashes } from '~/server/services/model.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createJob } from './job';

/**
 * Decide whether a queue entry has multiple buckets and therefore needs merging.
 *
 * The HA/Sentinel sysRedis client returns BLOB_STRING replies as a Buffer (no
 * `.split`) where the normal client returns a string. Coerce to a utf8 string
 * first — mirrors redis/queues.ts getBucketNames. The bucket value is always
 * written as a comma-joined string, so decode-then-split is exact. An empty or
 * falsy value (or a single-bucket entry) has nothing to merge → skip.
 */
export function shouldMergeBuckets(buckets: unknown): boolean {
  const asString = Buffer.isBuffer(buckets)
    ? buckets.toString('utf8')
    : (buckets as string | null | undefined);
  if (!asString) return false;
  return asString.split(',').length > 1;
}

export const cacheCleanup = createJob('cache-cleanup', '0 */1 * * *', async () => {
  // Note: Rate limit cleanup not needed - Redis hExpire handles TTL automatically
  // Note: Token state cleanup not needed - Redis hExpire handles TTL automatically

  // Merge queues
  const queues = await sysRedis.hGetAll(REDIS_SYS_KEYS.QUEUES.BUCKETS);
  const mergeTasks = Object.entries(queues).map(([key, buckets]) => async () => {
    // The HA/Sentinel sysRedis client returns BLOB_STRING replies as a Buffer
    // (no `.split`), so `buckets.split(',')` threw `i?.split is not a function`.
    // Mirror the coercion in redis/queues.ts getBucketNames — the bucket value is
    // always written as a comma-joined string, so decode-then-split is exact.
    // (Sentinel-mode gap missed by #2697/#2700.)
    if (!shouldMergeBuckets(buckets)) return;
    await mergeQueue(key);
  });
  await limitConcurrency(mergeTasks, 3);

  // Refresh materialized views
  await refreshBlockedModelHashes();
});
