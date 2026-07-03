import type { RedisKeyTemplateSys } from '~/server/redis/client';
import {
  REDIS_SUB_KEYS,
  REDIS_SYS_KEYS,
  sysRedis,
  withSysReadDeadline,
} from '~/server/redis/client';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';

// ---------------------------------------------------------------------------
// Fail-open sysRedis helpers for the search-index queue.
//
// This queue is driven inline by `SearchIndexUpdate.queueUpdate` from inside
// content mutations (model/image/collection/post publish/update/delete). The
// sys client (`~/server/redis/client`) is built with `socketTimeout: 0` (no
// socket timeout) + `disableOfflineQueue: true`, which gives two failure modes:
//
//   - DOWN / reconnecting → commands reject FAST → a try/catch survives it.
//   - SLOW / silent half-open (client believes it's connected) → an awaited
//     command PARKS until OS TCP keepalive (~11min). A try/catch alone NEVER
//     saves this — it doesn't throw in time. Only a wall-clock deadline race
//     (`withSysReadDeadline`) unblocks the caller.
//
// So EVERY op below is BOTH deadline-raced AND try/catch fail-open. Dropping a
// search-index enqueue is acceptable degradation: the content is picked up by
// the next full reindex. It must NEVER 500 or hang a content mutation.
//
// `withSysReadDeadline` is named for reads but is functionally a
// `Promise.race([op, deadline])` — it unblocks the CALLER even for a write (the
// orphaned write may still park the connection in the background, but the
// mutation flow returns). So writes are wrapped in it too.
// ---------------------------------------------------------------------------

/**
 * Deadline-raced + fail-open sysRedis READ. On DOWN (fast reject) or SLOW
 * (deadline fires) returns `fallback` with cache-miss semantics and logs a
 * `read-degraded` fail-open warning (Loki `sysredis-fail-open` signal).
 */
async function safeSysRead<T>(
  op: () => Promise<T>,
  fallback: T,
  fn: string,
  extra?: Record<string, unknown>
): Promise<T> {
  try {
    return await withSysReadDeadline(op());
  } catch (err) {
    logSysRedisFailOpen('read-degraded', fn, err, extra);
    return fallback;
  }
}

/**
 * Deadline-raced + fail-open sysRedis WRITE. On DOWN or SLOW the write is
 * dropped (best-effort — the enqueue is simply lost, content re-indexes on the
 * next full reindex) and a `write-degraded` fail-open warning is logged.
 */
async function safeSysWrite(
  op: () => Promise<unknown>,
  fn: string,
  extra?: Record<string, unknown>
): Promise<void> {
  try {
    await withSysReadDeadline(op());
  } catch (err) {
    logSysRedisFailOpen('write-degraded', fn, err, extra);
  }
}

async function getBucketNames(key: string) {
  const currentBucket = await safeSysRead<string | Buffer | null | undefined>(
    () =>
      sysRedis.hGet(REDIS_SYS_KEYS.QUEUES.BUCKETS, key) as Promise<
        string | Buffer | null | undefined
      >,
    null, // sysRedis DOWN/SLOW → treat as an empty queue (cache-miss)
    'queues.getBucketNames hGet',
    { key }
  );
  // sysRedis.hGet is typed to return a string, but the live HA/Sentinel client
  // can hand back a Buffer for the BLOB_STRING reply. A Buffer has no `.split`,
  // so `currentBucket?.split(',')` threw `i?.split is not a function` and 500'd
  // EVERY content-create mutation that enqueues a search-index update
  // (post.createWithImages, modelVersion.upsert, collection.saveItem, …). Coerce
  // to a utf8 string first — the bucket value is always written as a comma-joined
  // string (see hSet calls below), so decoding then splitting is exact.
  const asString = Buffer.isBuffer(currentBucket)
    ? currentBucket.toString('utf8')
    : (currentBucket as string | null | undefined);
  return (asString ? asString.split(',') : []) as RedisKeyTemplateSys[]; // values are redis key names
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
    await safeSysWrite(
      () => sysRedis.hSet(REDIS_SYS_KEYS.QUEUES.BUCKETS, key, targetBucket),
      'queues.addToQueue hSet',
      { key }
    );
  }
  const content = ids.map((id) => id.toString());
  await safeSysWrite(() => sysRedis.sAdd(targetBucket, content), 'queues.addToQueue sAdd', {
    key,
  });
}

export async function checkoutQueue(key: string, isMerge = false, readOnly = false) {
  if (!isMerge) await waitForMerge(key);

  // Get the current buckets
  const currentBuckets = await getBucketNames(key);

  if (!readOnly) {
    // Append new bucket
    const newBucket = getNewBucket(key);
    await safeSysWrite(
      () =>
        sysRedis.hSet(REDIS_SYS_KEYS.QUEUES.BUCKETS, key, [newBucket, ...currentBuckets].join(',')),
      'queues.checkoutQueue hSet',
      { key }
    );
  }

  // Fetch the content of the current buckets
  const content = new Set<number>();
  if (currentBuckets) {
    for (const bucket of currentBuckets) {
      const bucketContent =
        (
          await safeSysRead<string[]>(
            () => sysRedis.sMembers(bucket),
            [], // sysRedis DOWN/SLOW → this bucket contributes no ids (re-indexed later)
            'queues.checkoutQueue sMembers',
            { key, bucket }
          )
        )?.map((id) => parseInt(id)) ?? [];
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
      await safeSysWrite(
        () => sysRedis.hSet(REDIS_SYS_KEYS.QUEUES.BUCKETS, key, newBuckets.join(',')),
        'queues.checkoutQueue commit hSet',
        { key }
      );

      // Remove the processed buckets
      if (currentBuckets.length > 0)
        await safeSysWrite(() => sysRedis.del(currentBuckets), 'queues.checkoutQueue commit del', {
          key,
        });
    },
  };
}

// Busy-loop bound: the merge lock carries EX:60 (mergeQueue) so it self-clears
// within a minute even if the holder dies. Cap the poll so a sysRedis stall (or
// a wedged lock) can never spin forever — on a DOWN/SLOW `exists`, safeSysRead
// returns 0 ("not merging") fast and we proceed; this cap only guards the case
// where `exists` keeps genuinely returning truthy.
const WAIT_FOR_MERGE_MAX_ITERATIONS = 100; // ~10s at the 100ms poll interval
const WAIT_FOR_MERGE_POLL_MS = 100;

async function waitForMerge(key: string) {
  const mergeKey = `${REDIS_SYS_KEYS.QUEUES.BUCKETS}:${key}:${REDIS_SUB_KEYS.QUEUES.MERGING}`;
  for (let i = 0; i < WAIT_FOR_MERGE_MAX_ITERATIONS; i++) {
    const isMerging = await safeSysRead(
      () => sysRedis.exists(mergeKey),
      0, // DOWN/SLOW → treat as "not merging" and proceed (fail-open)
      'queues.waitForMerge exists',
      { key }
    );
    if (!isMerging) return;
    await new Promise((resolve) => setTimeout(resolve, WAIT_FOR_MERGE_POLL_MS));
  }
  // Lock never cleared within the cap — bail out fail-open rather than block the
  // enqueue forever. The stale lock expires via its own EX:60.
  logSysRedisFailOpen(
    'read-degraded',
    'queues.waitForMerge cap-reached',
    new Error('waitForMerge exceeded max iterations; proceeding without merge'),
    { key }
  );
}

export async function mergeQueue(key: string) {
  // Set the merging lock
  await safeSysWrite(
    () =>
      sysRedis.set(
        `${REDIS_SYS_KEYS.QUEUES.BUCKETS}:${key}:${REDIS_SUB_KEYS.QUEUES.MERGING}`,
        '1',
        {
          EX: 60,
        }
      ),
    'queues.mergeQueue set-lock',
    { key }
  );

  // Get the current queue
  const queue = await checkoutQueue(key, true);
  if (queue.content.length > 0) {
    // If we have content, move it to the newest bucket
    await addToQueue(key, queue.content);
  }
  await queue.commit();

  // Remove the merging lock
  await safeSysWrite(
    () => sysRedis.del(`${REDIS_SYS_KEYS.QUEUES.BUCKETS}:${key}:${REDIS_SUB_KEYS.QUEUES.MERGING}`),
    'queues.mergeQueue del-lock',
    { key }
  );
}
