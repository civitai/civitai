import type { RedisKeyTemplateSys } from '~/server/redis/client';
import {
  REDIS_SUB_KEYS,
  REDIS_SYS_KEYS,
  sysRedis,
  withSysReadDeadline,
} from '~/server/redis/client';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';

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
// Recovery for a dropped enqueue: the ids are parked in Postgres and replayed by
// `search-index-queue-drain` (see FALLBACK_KEY_PREFIX below). That is the only
// recovery a dropped DELETE has ever had — the delta `update` job's `updatedAt`
// range-scan re-derives updates but cannot re-derive a delete, and the daily
// `search-index-cleanup` reconciles neither images index (`CLEANUP_INDEXES` in
// meilisearch/cleanup.ts covers models/articles/users/collections/bounties/tools/
// comics only). Metrics likewise have no range-scan, so the parking lot is their
// only recovery too.
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
 *
 * Returns whether the write landed, so a caller with somewhere durable to put
 * the work can tell a completed write from a swallowed one.
 */
async function safeSysWrite(
  op: () => Promise<unknown>,
  fn: string,
  extra?: Record<string, unknown>
): Promise<boolean> {
  try {
    await withSysReadDeadline(op());
    return true;
  } catch (err) {
    logSysRedisFailOpen('write-degraded', fn, err, extra);
    return false;
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

const QUEUE_ADD_CHUNK_SIZE = 10000;

/**
 * Postgres parking lot for enqueues sysRedis refused. `Delete` is why it exists: a
 * dropped `Update` is re-derived by the delta `updatedAt` range-scan, but nothing can
 * re-derive a delete from a row that is already gone, so the id is simply lost and the
 * document stays in the index forever. Postgres is the store that is, by construction,
 * not the one currently failing.
 */
const FALLBACK_KEY_PREFIX = 'search-index-queue-fallback:';

/**
 * Ceiling per queue key. A single fan-out can carry ~211K ids and this is a JSON column,
 * not a queue — past this the parking lot stops absorbing rather than growing without
 * bound through a long outage. Hitting it is itself the signal that the outage needs a
 * full reindex, not a replay.
 */
const FALLBACK_MAX_IDS_PER_KEY = 100000;

async function persistDroppedEnqueue(key: string, ids: number[]) {
  if (!ids.length) return;
  try {
    const [row] = await dbWrite.$queryRaw<{ capped: boolean }[]>`
      INSERT INTO "KeyValue" ("key", "value")
      VALUES (${FALLBACK_KEY_PREFIX + key}, ${JSON.stringify(ids)}::jsonb)
      ON CONFLICT ("key") DO UPDATE SET "value" =
        CASE
          WHEN jsonb_array_length("KeyValue"."value") >= ${FALLBACK_MAX_IDS_PER_KEY}
            THEN "KeyValue"."value"
          ELSE "KeyValue"."value" || EXCLUDED."value"
        END
      RETURNING (jsonb_array_length("value") >= ${FALLBACK_MAX_IDS_PER_KEY}) AS capped
    `;
    // The CASE above keeps the old value once the cap is reached, which discards the
    // incoming ids. Say so: a full parking lot means the outage has outlasted what a
    // replay can fix and the index needs reconciling, and that has to be louder than
    // the per-drop warning the caller already logged.
    if (row?.capped) {
      logToAxiom({
        type: 'error',
        name: 'search-index-queue-fallback',
        message: `parking lot for ${key} is at the ${FALLBACK_MAX_IDS_PER_KEY} id cap; ${ids.length} id(s) discarded`,
      }).catch(() => undefined);
    }
  } catch (err) {
    // Both stores are now failing. Nothing left to try — log and let the caller
    // report the drop, exactly as it did before this fallback existed.
    logToAxiom({
      type: 'error',
      name: 'search-index-queue-fallback',
      message: `could not park ${ids.length} dropped id(s) for ${key}: ${(err as Error).message}`,
    }).catch(() => undefined);
  }
}

/**
 * Replay everything parked back onto the real queue.
 *
 * 🔴 Reads BEFORE it deletes, and deletes only the row it actually replayed — the same
 * rule `checkoutQueue` follows below, for the same reason. An earlier version used
 * `DELETE … RETURNING` as the checkout, which commits the removal before the replay is
 * attempted: a pod dying in that window destroyed the very ids this table exists to
 * protect. Nothing else can rebuild them.
 *
 * Replaying is safe to repeat, which is what makes read-then-delete affordable here: a
 * `Delete` for a document already gone and an `Update` for an unchanged row are both
 * no-ops downstream.
 */
export async function drainDroppedEnqueues() {
  const rows = await dbWrite.$queryRaw<{ key: string; value: unknown }[]>`
    SELECT "key", "value" FROM "KeyValue" WHERE "key" LIKE ${`${FALLBACK_KEY_PREFIX}%`}
  `;

  let replayed = 0;
  let reparked = 0;
  for (const row of rows) {
    if (!Array.isArray(row.value)) {
      // No replay can ever consume this, so retrying it forever is just a leak.
      await dbWrite.$executeRaw`
        DELETE FROM "KeyValue"
        WHERE "key" = ${row.key} AND jsonb_typeof("value") <> 'array'
      `;
      continue;
    }

    const ids = row.value as number[];
    // `park: false` — the row IS the parking lot entry, and it is still there. Letting
    // the enqueue re-park on failure would append a second copy of every id.
    if (ids.length && !(await enqueue(row.key.slice(FALLBACK_KEY_PREFIX.length), ids, false))) {
      reparked += ids.length;
      continue; // left parked; the next run retries it
    }
    replayed += ids.length;

    // Length guard, not an unconditional delete by key: a drop landing between the read
    // and here appends to the same row, and deleting it wholesale would swallow ids that
    // were never replayed. A grown row survives and is replayed in full next run —
    // duplicated work, which is a no-op, rather than lost work, which is not.
    await dbWrite.$executeRaw`
      DELETE FROM "KeyValue"
      WHERE "key" = ${row.key}
        AND jsonb_typeof("value") = 'array'
        AND jsonb_array_length("value") = ${ids.length}
    `;
  }
  return { keys: rows.length, replayed, reparked };
}

/** @returns whether every id reached the queue; dropped ids are parked for replay. */
export async function addToQueue(
  key: string,
  ids: number | number[] | Set<number>
): Promise<boolean> {
  return enqueue(key, ids, true);
}

/**
 * @param park whether a dropped id should be written to the Postgres parking lot. Only
 * the drain passes false, because its ids are already parked.
 */
async function enqueue(
  key: string,
  ids: number | number[] | Set<number>,
  park: boolean
): Promise<boolean> {
  if (!Array.isArray(ids)) {
    if (ids instanceof Set) ids = Array.from(ids);
    else ids = [ids];
  }
  const { buckets: currentBuckets, degraded } = await getBucketNames(key);
  if (degraded) {
    // The bucket-list read failed open (false-empty). Writing a fresh bucket
    // reference here (`hSet(BUCKETS, key, newBucket)`) would OVERWRITE the hash
    // field and orphan any pre-existing buckets, so the enqueue cannot proceed
    // against redis — it goes to the parking lot instead.
    logSysRedisFailOpen(
      'write-degraded',
      'queues.addToQueue skipped-degraded-read',
      new Error('bucket-list read degraded; enqueue skipped to avoid orphaning existing buckets'),
      { key }
    );
    if (park) await persistDroppedEnqueue(key, ids);
    return false;
  }
  let targetBucket = currentBuckets[0];
  if (!targetBucket) {
    targetBucket = getNewBucket(key);
    const registered = await safeSysWrite(
      () => sysRedis.hSet(REDIS_SYS_KEYS.QUEUES.BUCKETS, key, targetBucket),
      'queues.addToQueue hSet',
      { key }
    );
    // No consumer can reach an unregistered bucket, so writing ids into it would
    // put them somewhere nothing ever reads — indistinguishable from losing them.
    if (!registered) {
      if (park) await persistDroppedEnqueue(key, ids);
      return false;
    }
  }
  const content = ids.map((id) => id.toString());
  const dropped: number[] = [];
  // Chunked because callers can enqueue very large id sets in one go — propagating a model
  // flag to its gallery reaches ~211K images on the largest model — and a single sAdd that
  // size is a multi-MB command that stalls everything else on the connection.
  for (let i = 0; i < content.length; i += QUEUE_ADD_CHUNK_SIZE) {
    const chunk = content.slice(i, i + QUEUE_ADD_CHUNK_SIZE);
    const written = await safeSysWrite(
      () => sysRedis.sAdd(targetBucket, chunk),
      'queues.addToQueue sAdd',
      { key }
    );
    if (!written) dropped.push(...ids.slice(i, i + QUEUE_ADD_CHUNK_SIZE));
  }
  if (dropped.length) {
    if (park) await persistDroppedEnqueue(key, dropped);
    return false;
  }
  return true;
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
  // Cast to the branded key type: extracting the template literal into a const widens it to
  // `string`, losing the contextual RedisKeyTemplateSys match the inline literal had (mirrors
  // getNewBucket below). Without this, sysRedis.exists() rejects it (TS2345) — caught only by the
  // preview build's typecheck, not local tsc against stale @civitai/redis types.
  const mergeKey =
    `${REDIS_SYS_KEYS.QUEUES.BUCKETS}:${key}:${REDIS_SUB_KEYS.QUEUES.MERGING}` as RedisKeyTemplateSys;
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
