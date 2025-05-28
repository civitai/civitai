import type { RedisKeyTemplateSys } from '~/server/redis/client';
import { REDIS_SUB_KEYS, REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';

async function getBucketNames(key: string) {
  const currentBucket = await sysRedis.hGet(REDIS_SYS_KEYS.QUEUES.BUCKETS, key);
  return (currentBucket?.split(',') ?? []) as RedisKeyTemplateSys[]; // values are redis key names
}

function getNewBucket(key: string) {
  return `${REDIS_SYS_KEYS.QUEUES.BUCKETS}:${key}:${Date.now()}` as RedisKeyTemplateSys;
}

export async function addToQueue(key: string, ids: number | number[] | Set<number>) {
  if (!Array.isArray(ids)) {
    if (ids instanceof Set) ids = Array.from(ids);
    else ids = [ids];
  }
  const currentBuckets = await getBucketNames(key);
  let targetBucket = currentBuckets[0];
  if (!targetBucket) {
    targetBucket = getNewBucket(key);
    await sysRedis.hSet(REDIS_SYS_KEYS.QUEUES.BUCKETS, key, targetBucket);
  }
  const content = ids.map((id) => id.toString());
  await sysRedis.sAdd(targetBucket, content);
}

export async function checkoutQueue(key: string, isMerge = false, readOnly = false) {
  if (!isMerge) await waitForMerge(key);

  // Get the current buckets
  const currentBuckets = await getBucketNames(key);

  if (!readOnly) {
    // Append new bucket
    const newBucket = getNewBucket(key);
    await sysRedis.hSet(
      REDIS_SYS_KEYS.QUEUES.BUCKETS,
      key,
      [newBucket, ...currentBuckets].join(',')
    );
  }

  // Fetch the content of the current buckets
  const content = new Set<number>();
  if (currentBuckets) {
    for (const bucket of currentBuckets) {
      const bucketContent = (await sysRedis.sMembers(bucket))?.map((id) => parseInt(id)) ?? [];
      for (const id of bucketContent) content.add(id);
    }
  }

  return {
    content: [...content],
    commit: async () => {
      if (readOnly) {
        return; // Nothing to commit.
      }
      // Remove the reference to the processed buckets
      const existingBuckets = await getBucketNames(key);
      const newBuckets = existingBuckets.filter((bucket) => !currentBuckets.includes(bucket));
      await sysRedis.hSet(REDIS_SYS_KEYS.QUEUES.BUCKETS, key, newBuckets.join(','));

      // Remove the processed buckets
      if (currentBuckets.length > 0) await sysRedis.del(currentBuckets);
    },
  };
}

async function waitForMerge(key: string) {
  let isMerging = await sysRedis.exists(
    `${REDIS_SYS_KEYS.QUEUES.BUCKETS}:${key}:${REDIS_SUB_KEYS.QUEUES.MERGING}`
  );
  while (isMerging) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    isMerging = await sysRedis.exists(
      `${REDIS_SYS_KEYS.QUEUES.BUCKETS}:${key}:${REDIS_SUB_KEYS.QUEUES.MERGING}`
    );
  }
}

export async function mergeQueue(key: string) {
  // Set the merging lock
  await sysRedis.set(
    `${REDIS_SYS_KEYS.QUEUES.BUCKETS}:${key}:${REDIS_SUB_KEYS.QUEUES.MERGING}`,
    '1',
    {
      EX: 60,
    }
  );

  // Get the current queue
  const queue = await checkoutQueue(key, true);
  if (queue.content.length > 0) {
    // If we have content, move it to the newest bucket
    await addToQueue(key, queue.content);
  }
  await queue.commit();

  // Remove the merging lock
  await sysRedis.del(`${REDIS_SYS_KEYS.QUEUES.BUCKETS}:${key}:${REDIS_SUB_KEYS.QUEUES.MERGING}`);
}
