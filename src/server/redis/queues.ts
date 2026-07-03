import type { RedisKeyTemplateSys } from '~/server/redis/client';
import {
  REDIS_SUB_KEYS,
  REDIS_SYS_KEYS,
  sysRedis,
  withSysReadDeadline,
} from '~/server/redis/client';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';

// ---------------------------------------------------------------------------
// Fail-open sysRedis helpers for the queue used by search-index AND metrics.
//
// This queue is driven inline by `SearchIndexUpdate.queueUpdate` (→ addToQueue)
// from inside content mutations (model/image/collection/post publish/update/
// delete), and consumed on background crons by base.search-index.ts
// (processQueues/update, → checkoutQueue) and base.metrics.ts. The SAME fns are
// also used by research.webhooks.ts, training-moderation.webhooks.ts, and
// cache-cleanup.ts (mergeQueue) — so this is NOT search-index-only; a metrics
// enqueue dropped here has NO updatedAt range-scan to re-catch it (see recovery
// note below).
//
// The sys client (`~/server/redis/client`) is built with `socketTimeout: 0` (no
// socket timeout) + `disableOfflineQueue: true`, which gives two failure modes:
//
//   - DOWN / reconnecting → commands reject FAST → a try/catch survives it.
//   - SLOW / silent half-open (client believes it's connected) → an awaited
//     command PARKS until OS TCP keepalive (~11min). A try/catch alone NEVER
//     saves this — it doesn't throw in time. Only a wall-clock deadline race
//     (`withSysReadDeadline`) unblocks the caller.
//
// So EVERY op below is BOTH deadline-raced AND try/catch fail-open. It must
// NEVER 500 or hang a content mutation.
//
// NON-DESTRUCTIVE fail-open (the important invariant): a fail-OPEN read returns
// a false-empty result. We must NEVER let a false-empty read drive a write that
// assumes the read was complete — that would DISCARD already-queued work (worse
// than the pre-PR behavior, where a throwing read aborted the job and preserved
// the data for retry). Concretely: (1) if `getBucketNames` fails open we do NOT
// rewrite the bucket-list hash field (that would orphan pre-existing buckets),
// and (2) `commit()` only deletes buckets it ACTUALLY read+processed — a bucket
// whose `sMembers` failed open is left queued for the next run. Prefer
// "skip + retry next run" over "proceed on a false-empty read + destructive write".
//
// Automatic recovery for a dropped enqueue: for search-index it's the delta
// `update` job's `updatedAt` range-scan (≤15min) plus the daily
// `search-index-cleanup` (dropped-delete orphans) — NOT the full-reset job,
// which runs at UNRUNNABLE_JOB_CRON (manual, unscheduled). Metrics have no such
// range-scan, so a dropped metrics enqueue just yields momentarily stale metrics
// until the entity is next touched.
//
// `withSysReadDeadline` is named for reads but is functionally a
// `Promise.race([op, deadline])` — it unblocks the CALLER even for a write (the
// orphaned write may still park the connection in the background, but the flow
// returns). So writes are wrapped in it too.
// ---------------------------------------------------------------------------

// The queue CONSUMERS (base.search-index.ts processQueues/update + base.metrics.ts)
// run on background crons — NOT the latency-critical inline mutation path — and a
// large sMembers on a healthy-but-BUSY sysRedis can legitimately exceed the tight
// inline read deadline (default REDIS_SYS_READ_TIMEOUT_MS ≈ 2s), producing a false
// timeout that (now, non-destructively) just skips-and-retries the run. Give the
// consumer bucket-content reads a larger deadline so we don't needlessly defer a
// run on transient busyness; a true half-open still fails open, just after a
// longer bound. The inline addToQueue path keeps the tight default deadline.
const QUEUE_CONSUMER_READ_TIMEOUT_MS = 15_000;

type SafeReadResult<T> = { value: T; degraded: boolean };

/**
 * Deadline-raced + fail-open sysRedis READ. Returns `{ value, degraded }`:
 * on DOWN (fast reject) or SLOW (deadline fires) `value` is `fallback`
 * (cache-miss semantics) and `degraded` is true, and a `read-degraded` fail-open
 * warning is logged (Loki `sysredis-fail-open` signal). Callers MUST consult
 * `degraded` before performing any write that assumes the read was complete.
 * `deadlineMs` overrides the wall-clock deadline (undefined → the client default).
 */
async function safeSysRead<T>(
  op: () => Promise<T>,
  fallback: T,
  fn: string,
  extra?: Record<string, unknown>,
  deadlineMs?: number
): Promise<SafeReadResult<T>> {
  try {
    return { value: await withSysReadDeadline(op(), deadlineMs), degraded: false };
  } catch (err) {
    logSysRedisFailOpen('read-degraded', fn, err, extra);
    return { value: fallback, degraded: true };
  }
}

/**
 * Deadline-raced + fail-open sysRedis WRITE. On DOWN or SLOW the write is
 * dropped (best-effort) and a `write-degraded` fail-open warning is logged.
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

async function getBucketNames(
  key: string
): Promise<{ buckets: RedisKeyTemplateSys[]; degraded: boolean }> {
  const { value: currentBucket, degraded } = await safeSysRead<string | Buffer | null | undefined>(
    () =>
      sysRedis.hGet(REDIS_SYS_KEYS.QUEUES.BUCKETS, key) as Promise<
        string | Buffer | null | undefined
      >,
    null, // sysRedis DOWN/SLOW → treat as an empty queue, but flag `degraded`
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
  const buckets = (asString ? asString.split(',') : []) as RedisKeyTemplateSys[]; // values are redis key names
  return { buckets, degraded };
}

function getNewBucket(key: string) {
  return `${REDIS_SYS_KEYS.QUEUES.BUCKETS}:${key}:${Date.now()}` as RedisKeyTemplateSys;
}

export async function addToQueue(key: string, ids: number | number[] | Set<number>) {
  if (!Array.isArray(ids)) {
    if (ids instanceof Set) ids = Array.from(ids);
    else ids = [ids];
  }
  const { buckets: currentBuckets, degraded } = await getBucketNames(key);
  if (degraded) {
    // The bucket-list read failed open (false-empty). Writing a fresh bucket
    // reference here (`hSet(BUCKETS, key, newBucket)`) would OVERWRITE the hash
    // field and orphan any pre-existing buckets. Skip the enqueue entirely — the
    // update is dropped (recovered by the delta update-scan / next trigger)
    // rather than clobbering the queue.
    logSysRedisFailOpen(
      'write-degraded',
      'queues.addToQueue skipped-degraded-read',
      new Error('bucket-list read degraded; enqueue skipped to avoid orphaning existing buckets'),
      { key }
    );
    return;
  }
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

  // Get the current buckets. If this read failed open we do NOT know the real
  // bucket list — abort the whole checkout: process nothing, write nothing,
  // delete nothing. Leaves the queue intact for the next run.
  const { buckets: currentBuckets, degraded: bucketsDegraded } = await getBucketNames(key);
  if (bucketsDegraded) {
    return { content: [] as number[], commit: async () => {} };
  }

  if (!readOnly) {
    // Append new bucket. Safe: currentBuckets is a complete read (not degraded).
    const newBucket = getNewBucket(key);
    await safeSysWrite(
      () =>
        sysRedis.hSet(REDIS_SYS_KEYS.QUEUES.BUCKETS, key, [newBucket, ...currentBuckets].join(',')),
      'queues.checkoutQueue hSet',
      { key }
    );
  }

  // Fetch the content of the current buckets. Track ONLY the buckets we actually
  // read successfully — a bucket whose sMembers failed open contributed no ids
  // and must NOT be deleted in commit() (that would silently discard its queued
  // work). Consumer reads get a larger deadline (see constant above).
  const content = new Set<number>();
  const readBuckets: RedisKeyTemplateSys[] = [];
  for (const bucket of currentBuckets) {
    const { value: members, degraded } = await safeSysRead<string[]>(
      () => sysRedis.sMembers(bucket),
      [], // DOWN/SLOW → this bucket contributes no ids AND is left queued (not deleted)
      'queues.checkoutQueue sMembers',
      { key, bucket },
      QUEUE_CONSUMER_READ_TIMEOUT_MS
    );
    if (degraded) continue; // do NOT mark this bucket as processed → preserve it
    readBuckets.push(bucket);
    for (const id of members.map((m) => parseInt(m))) content.add(id);
  }

  return {
    content: [...content],
    commit: async () => {
      if (readOnly) {
        return; // Nothing to commit.
      }
      // Only retire buckets we ACTUALLY read+processed. If none were safely read
      // (e.g. every sMembers failed open, or the queue was empty), skip the
      // rewrite entirely — leave the bucket list untouched for the next run and
      // avoid clobbering any buckets appended concurrently during processing.
      if (readBuckets.length === 0) return;

      // Re-read the current bucket list. If THIS read failed open we can't safely
      // rewrite it (a false-empty → over-broad delete) — leave it intact, retry.
      const { buckets: existingBuckets, degraded } = await getBucketNames(key);
      if (degraded) return;

      const newBuckets = existingBuckets.filter((bucket) => !readBuckets.includes(bucket));
      await safeSysWrite(
        () => sysRedis.hSet(REDIS_SYS_KEYS.QUEUES.BUCKETS, key, newBuckets.join(',')),
        'queues.checkoutQueue commit hSet',
        { key }
      );

      // Remove ONLY the processed buckets' set data.
      await safeSysWrite(() => sysRedis.del(readBuckets), 'queues.checkoutQueue commit del', {
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
    const { value: isMerging } = await safeSysRead(
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
