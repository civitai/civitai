import { redis, REDIS_KEYS } from '~/server/redis/client';

async function getBucketNames(key: string) {
  const currentBucket = await redis.hGet(REDIS_KEYS.SEARCH_INDEX.BUCKETS, key);
  return currentBucket?.split(',') ?? [];
}

function getNewBucketName(key: string) {
  return `${REDIS_KEYS.SEARCH_INDEX.BUCKETS}:${key}:${Date.now()}`;
}

export async function addToQueue(key: string, ids: number | number[] | Set<number>) {
  if (!Array.isArray(ids)) {
    if (ids instanceof Set) ids = Array.from(ids);
    else ids = [ids];
  }
  const currentBuckets = await getBucketNames(key);
  const targetBucket = currentBuckets[0] ?? getNewBucketName(key);
  const content = ids.map((id) => id.toString());
  await redis.sAdd(targetBucket, content);
}

export async function checkoutQueue(key: string) {
  // Get the current buckets
  const currentBuckets = await getBucketNames(key);

  // Append new bucket
  const newBucket = getNewBucketName(key);
  await redis.hSet(REDIS_KEYS.SEARCH_INDEX.BUCKETS, key, [newBucket, ...currentBuckets].join(','));

  // Fetch the content of the current buckets
  const content = new Set<number>();
  if (currentBuckets) {
    for (const bucket of currentBuckets) {
      const bucketContent = (await redis.sMembers(bucket))?.map((id) => parseInt(id)) ?? [];
      for (const id of bucketContent) content.add(id);
    }
  }

  return {
    content: [...content],
    commit: async () => {
      // Remove the reference to the processed buckets
      const existingBuckets = await getBucketNames(key);
      const newBuckets = existingBuckets.filter((bucket) => !currentBuckets.includes(bucket));
      await redis.hSet(REDIS_KEYS.SEARCH_INDEX.BUCKETS, key, newBuckets.join(','));

      // Remove the processed buckets
      await redis.del(currentBuckets);
    },
  };
}
