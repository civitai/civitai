import { beforeEach, describe, expect, it, vi } from 'vitest';

// queues.ts imports the real redis client module, which opens sockets at load.
// Mock it to an in-memory sysRedis whose hGet reply type (string vs Buffer) we
// control per-test — that's the exact axis of the original bug. The mock fns are
// created via vi.hoisted so they exist before vi.mock's hoisted factory
// references them.
// Everything referenced by a vi.mock factory must be hoisted (vi.mock is lifted
// to the top of the file). `state.deadlineDisabled` is a mutable holder tests
// flip to drop the deadline guard for the busy-loop cap test.
const {
  hGet,
  hSet,
  sAdd,
  sMembers,
  del,
  exists,
  set,
  withSysReadDeadline,
  logSysRedisFailOpen,
  executeRaw,
  queryRaw,
  logToAxiom,
  state,
} = vi.hoisted(() => {
  // Real-ish wall-clock deadline race. Mirrors sys-read-deadline.ts so the
  // SLOW/hang path is genuinely exercised: a never-resolving op loses the race
  // and rejects with a timeout error, which queues.ts must catch and fail open.
  // The INTERNAL timer is a fixed small value (env-independent) regardless of
  // the requested `ms` — so a large consumer deadline (15s) doesn't make the
  // SLOW tests actually wait 15s; the reported error message still echoes the
  // requested `ms` (so the consumer deadline is observable via the message).
  const INTERNAL_DEADLINE_MS = 50;
  const holder = { deadlineDisabled: false };
  return {
    hGet: vi.fn(),
    hSet: vi.fn(() => Promise.resolve(1)),
    sAdd: vi.fn(() => Promise.resolve(1)),
    sMembers: vi.fn((_bucket?: string) => Promise.resolve([] as string[])),
    del: vi.fn(() => Promise.resolve(1)),
    exists: vi.fn(() => Promise.resolve(0)),
    set: vi.fn(() => Promise.resolve('OK')),
    logSysRedisFailOpen: vi.fn(),
    executeRaw: vi.fn(() => Promise.resolve(1)),
    queryRaw: vi.fn(() => Promise.resolve([] as { key: string; value: unknown }[])),
    logToAxiom: vi.fn(() => Promise.resolve()),
    state: holder,
    withSysReadDeadline: vi.fn(<T>(p: Promise<T>, ms?: number): Promise<T> => {
      if (holder.deadlineDisabled) return p;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`sysRedis read timed out after ${ms ?? 'default'}ms`)),
          INTERNAL_DEADLINE_MS
        );
      });
      return Promise.race([p, deadline]).finally(() => {
        if (timer) clearTimeout(timer);
      });
    }),
  };
});

vi.mock('~/server/redis/client', () => ({
  sysRedis: { hGet, hSet, sAdd, sMembers, del, exists, set },
  REDIS_SYS_KEYS: { QUEUES: { BUCKETS: 'queues:buckets' } },
  REDIS_SUB_KEYS: { QUEUES: { MERGING: 'merging' } },
  withSysReadDeadline,
}));

// The fail-open logger fires to Axiom; stub it so the tests don't touch the
// logging client (which opens its own IO) and so we can assert it was called.
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen }));

// The Postgres parking lot for dropped enqueues. Mocked at the client so the raw
// SQL shape stays observable — the tests below assert that ids were handed to it,
// which is the only way a lost delete is distinguishable from a dropped one.
vi.mock('~/server/db/client', () => ({
  dbWrite: { $executeRaw: executeRaw, $queryRaw: queryRaw },
  dbRead: { $executeRaw: executeRaw, $queryRaw: queryRaw },
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom }));

import { addToQueue, checkoutQueue, drainDroppedEnqueues, mergeQueue } from '~/server/redis/queues';

// The bucket value is always persisted as a comma-joined string (see hSet calls
// in queues.ts). This is the exact value the failing prod path read back.
const BUCKETS_CSV = 'queues:buckets:images_v6:Update:1782075142958';

const never = () => new Promise<never>(() => {}); // never settles — simulates a silent half-open park

beforeEach(() => {
  vi.clearAllMocks();
  state.deadlineDisabled = false;
  sMembers.mockResolvedValue([]);
  hSet.mockResolvedValue(1);
  sAdd.mockResolvedValue(1);
  del.mockResolvedValue(1);
  exists.mockResolvedValue(0);
  set.mockResolvedValue('OK');
  // Implementations, not just call history — vi.clearAllMocks only clears the latter,
  // so a per-test mockResolvedValue would otherwise leak into the next test.
  executeRaw.mockResolvedValue(1);
  queryRaw.mockResolvedValue([]);
});

// $queryRaw/$executeRaw are tagged templates: call[0] is the strings array, the rest
// are the interpolated values. The parking lot issues three different statements
// through the same two mocks, so tests match on the statement rather than the mock.
const sqlOf = (call: unknown[]) => (call[0] as unknown as string[]).join(' ? ');
const callsMatching = (mock: { mock: { calls: unknown[][] } }, fragment: string) =>
  mock.mock.calls.filter((c) => sqlOf(c).includes(fragment));

describe('getBucketNames (via queues.ts public API)', () => {
  // Regression: the HA/Sentinel sysRedis client returns BLOB_STRING replies as a
  // Buffer. `currentBucket?.split(',')` then threw `i?.split is not a function`,
  // 500-ing every content-create mutation that enqueues a search-index update
  // (post.createWithImages / modelVersion.upsert / collection.saveItem). The
  // optional chain guarded null but NOT a wrong-typed Buffer.
  it('does NOT throw and parses bucket names when hGet returns a Buffer', async () => {
    hGet.mockResolvedValue(Buffer.from(BUCKETS_CSV, 'utf8'));

    // The pre-fix code threw synchronously inside this call.
    await expect(checkoutQueue('images_v6:Update', false, true)).resolves.toBeDefined();

    // It read the existing bucket (did not mint+hSet a new one on the read-only path).
    expect(sMembers).toHaveBeenCalledWith(BUCKETS_CSV);
  });

  it('parses bucket names when hGet returns a plain string (unchanged behavior)', async () => {
    hGet.mockResolvedValue(BUCKETS_CSV);
    await expect(checkoutQueue('images_v6:Update', false, true)).resolves.toBeDefined();
    expect(sMembers).toHaveBeenCalledWith(BUCKETS_CSV);
  });

  it('treats a null hGet (empty queue) as no buckets — mints a fresh one on enqueue', async () => {
    hGet.mockResolvedValue(null);
    await addToQueue('images_v6:Update', [1, 2, 3]);
    // No existing bucket → a new bucket name is written, then ids are sAdd'd.
    expect(hSet).toHaveBeenCalledTimes(1);
    expect(sAdd).toHaveBeenCalledTimes(1);
  });

  it('chunks a large enqueue instead of issuing one oversized sAdd', async () => {
    hGet.mockResolvedValue(BUCKETS_CSV);
    const ids = Array.from({ length: 25000 }, (_, i) => i + 1);

    await addToQueue('images_v6:Update', ids);

    const calls = sAdd.mock.calls as unknown as Array<[string, string[]]>;
    expect(calls).toHaveLength(3);
    for (const [, chunk] of calls) expect(chunk.length).toBeLessThanOrEqual(10000);

    const written = calls.flatMap(([, chunk]) => chunk);
    expect(new Set(written).size).toBe(25000);
  });

  it('handles a multi-bucket Buffer reply (comma-joined) without throwing', async () => {
    const csv = `${BUCKETS_CSV},queues:buckets:images_v6:Update:1782075150000`;
    hGet.mockResolvedValue(Buffer.from(csv, 'utf8'));
    await checkoutQueue('images_v6:Update', false, true);
    // Both buckets are read.
    expect(sMembers).toHaveBeenCalledWith(BUCKETS_CSV);
    expect(sMembers).toHaveBeenCalledWith('queues:buckets:images_v6:Update:1782075150000');
  });
});

// ---------------------------------------------------------------------------
// Fail-open behavior (step 2 of the sysRedis soft-dependency sequence).
//
// The queue is driven inline by content mutations. A sysRedis outage must NEVER
// 500 or hang the mutation — dropping an enqueue degrades to "recovered by the
// delta update-scan / next trigger". Two failure modes:
//   - DOWN  → the sysRedis command REJECTS fast (try/catch catches it).
//   - SLOW  → the command PARKS forever (never rejects); only the deadline race
//             in withSysReadDeadline unblocks the caller.
// Every op must survive BOTH — AND the fail-open must be NON-DESTRUCTIVE: a
// false-empty read must never drive a write that discards already-queued work
// (see the "data-integrity" describe block below).
// ---------------------------------------------------------------------------
describe('queues fail-open — DOWN (sysRedis command rejects fast)', () => {
  const DOWN = () => Promise.reject(new Error('Redis connection lost'));

  it('addToQueue: a rejecting hGet (bucket-list) read SKIPS the enqueue — does not throw, does not clobber', async () => {
    hGet.mockImplementation(DOWN); // getBucketNames read is DOWN → degraded

    await expect(addToQueue('images_v6:Update', [1, 2, 3])).resolves.toBe(false);
    // Non-destructive: a false-empty bucket-list read must NOT drive a
    // bucket-reference overwrite (which would orphan pre-existing buckets).
    expect(hSet).not.toHaveBeenCalled();
    expect(sAdd).not.toHaveBeenCalled();
    expect(logSysRedisFailOpen).toHaveBeenCalledWith(
      'read-degraded',
      'queues.getBucketNames hGet',
      expect.any(Error),
      expect.objectContaining({ key: 'images_v6:Update' })
    );
    expect(logSysRedisFailOpen).toHaveBeenCalledWith(
      'write-degraded',
      'queues.addToQueue skipped-degraded-read',
      expect.any(Error),
      expect.objectContaining({ key: 'images_v6:Update' })
    );
  });

  it('addToQueue: a rejecting bucket registration parks the ids instead of writing them nowhere', async () => {
    hGet.mockResolvedValue(null); // empty queue → mints a new bucket
    hSet.mockImplementation(DOWN);
    sAdd.mockImplementation(DOWN);

    await expect(addToQueue('images_v6:Update', [1, 2, 3])).resolves.toBe(false);
    expect(logSysRedisFailOpen).toHaveBeenCalledWith(
      'write-degraded',
      'queues.addToQueue hSet',
      expect.any(Error),
      expect.any(Object)
    );
    // A bucket whose registration failed is unreachable by every consumer, so the
    // ids must NOT be written into it — they go to the parking lot instead.
    expect(sAdd).not.toHaveBeenCalled();
    expect(callsMatching(queryRaw, 'INSERT INTO "KeyValue"')).toHaveLength(1);
    expect(logSysRedisFailOpen).not.toHaveBeenCalledWith(
      'write-degraded',
      'queues.addToQueue sAdd',
      expect.any(Error),
      expect.any(Object)
    );
  });

  it('checkoutQueue: a rejecting sMembers read yields empty content — does not throw', async () => {
    hGet.mockResolvedValue(BUCKETS_CSV);
    sMembers.mockImplementation(DOWN);

    const queue = await checkoutQueue('images_v6:Update', false, true);
    expect(queue.content).toEqual([]);
    expect(logSysRedisFailOpen).toHaveBeenCalledWith(
      'read-degraded',
      'queues.checkoutQueue sMembers',
      expect.any(Error),
      expect.any(Object)
    );
  });

  it('mergeQueue: a rejecting lock write does not throw', async () => {
    hGet.mockResolvedValue(null);
    set.mockImplementation(DOWN);
    del.mockImplementation(DOWN);

    await expect(mergeQueue('images_v6:Update')).resolves.toBeUndefined();
  });
});

describe('queues fail-open — SLOW (sysRedis command parks; only the deadline saves it)', () => {
  it('addToQueue: a HANGING hGet read is unblocked by the deadline race and skips non-destructively (does not hang/throw)', async () => {
    // A try/catch ALONE would not save this — the op never rejects. The deadline
    // race in withSysReadDeadline is the only thing that unblocks the caller.
    hGet.mockImplementation(never);

    await expect(addToQueue('images_v6:Update', [1, 2, 3])).resolves.toBe(false);
    expect(withSysReadDeadline).toHaveBeenCalled();
    // Degraded read → skip; never clobbers the (unknown) real bucket list.
    expect(hSet).not.toHaveBeenCalled();
    expect(sAdd).not.toHaveBeenCalled();
    expect(logSysRedisFailOpen).toHaveBeenCalledWith(
      'read-degraded',
      'queues.getBucketNames hGet',
      expect.objectContaining({ message: expect.stringMatching(/timed out/) }),
      expect.any(Object)
    );
  });

  it('checkoutQueue: a HANGING sMembers read is deadline-bounded and yields empty content', async () => {
    hGet.mockResolvedValue(BUCKETS_CSV);
    sMembers.mockImplementation(never);

    const queue = await checkoutQueue('images_v6:Update', false, true);
    expect(queue.content).toEqual([]);
    expect(logSysRedisFailOpen).toHaveBeenCalledWith(
      'read-degraded',
      'queues.checkoutQueue sMembers',
      expect.objectContaining({ message: expect.stringMatching(/timed out/) }),
      expect.any(Object)
    );
  });

  it('addToQueue: a HANGING write (hSet) is deadline-bounded and swallowed', async () => {
    hGet.mockResolvedValue(null);
    hSet.mockImplementation(never);

    await expect(addToQueue('images_v6:Update', [1, 2, 3])).resolves.toBe(false);
    expect(logSysRedisFailOpen).toHaveBeenCalledWith(
      'write-degraded',
      'queues.addToQueue hSet',
      expect.objectContaining({ message: expect.stringMatching(/timed out/) }),
      expect.any(Object)
    );
  });
});

describe('waitForMerge — terminates under a persistent stall (does not loop forever)', () => {
  it('returns fast when exists HANGS (deadline → treated as not-merging)', async () => {
    // exists never resolves → each poll is deadline-bounded, returns 0 ("not
    // merging") → checkoutQueue proceeds on the very first iteration.
    hGet.mockResolvedValue(null);
    exists.mockImplementation(never);

    // checkoutQueue(key, isMerge=false) calls waitForMerge first.
    await expect(checkoutQueue('images_v6:Update', false, true)).resolves.toBeDefined();
  });

  it('returns fast when exists REJECTS (DOWN → treated as not-merging)', async () => {
    hGet.mockResolvedValue(null);
    exists.mockImplementation(() => Promise.reject(new Error('Redis connection lost')));

    await expect(checkoutQueue('images_v6:Update', false, true)).resolves.toBeDefined();
  });

  it('bails out (does not spin forever) when the lock stays genuinely held', async () => {
    // exists keeps returning truthy (a wedged lock that never clears). The
    // iteration cap must break the loop and fail open rather than hang.
    hGet.mockResolvedValue(null);
    exists.mockResolvedValue(1);
    // Skip the real deadline so the 100 iterations don't each wait 50ms.
    state.deadlineDisabled = true;
    // Make the 100ms poll instant.
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    try {
      await expect(checkoutQueue('images_v6:Update', false, true)).resolves.toBeDefined();
      expect(logSysRedisFailOpen).toHaveBeenCalledWith(
        'read-degraded',
        'queues.waitForMerge cap-reached',
        expect.any(Error),
        expect.any(Object)
      );
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });
});

// ---------------------------------------------------------------------------
// Data-integrity: the fail-open path must be NON-DESTRUCTIVE.
//
// The regression the audit caught: on a transient blip (a read fails open, then
// sysRedis recovers before the trailing write) the fail-open could SILENTLY
// DISCARD already-queued work — worse than pre-PR, where a throwing read aborted
// the job and preserved the data for retry. Two vectors, both fixed by gating
// destructive writes on whether the driving read was degraded.
// ---------------------------------------------------------------------------
describe('queues data-integrity — non-destructive fail-open (regression guard)', () => {
  const B1 = 'queues:buckets:images_v6:Update:111';
  const B2 = 'queues:buckets:images_v6:Update:222';

  it('checkoutQueue commit: a bucket whose sMembers read failed open is NOT deleted (preserved for retry)', async () => {
    // Two queued buckets; B1 reads fine, B2's read fails open mid-checkout.
    hGet.mockResolvedValue(`${B1},${B2}`);
    sMembers.mockImplementation((bucket?: string) =>
      bucket === B1 ? Promise.resolve(['1']) : Promise.reject(new Error('Redis connection lost'))
    );

    const queue = await checkoutQueue('images_v6:Update', false, false);
    // Only the readable bucket contributed ids.
    expect(queue.content).toEqual([1]);

    await queue.commit();

    // CORE REGRESSION: pre-fix, commit() del'd ALL captured buckets ([B1,B2]) and
    // rewrote the list removing them → B2's ids were dropped from the queue AND
    // indexed empty. Now only the successfully-read bucket is retired; B2 stays.
    expect(del).toHaveBeenCalledWith([B1]);
    expect(del).not.toHaveBeenCalledWith([B1, B2]);
    expect(del).not.toHaveBeenCalledWith([B2]);
    // The rewritten bucket list still references B2 (left queued for next run).
    expect(hSet).toHaveBeenCalledWith('queues:buckets', 'images_v6:Update', B2);
  });

  it('checkoutQueue: when EVERY sMembers read fails open, nothing is deleted and the list is not rewritten', async () => {
    hGet.mockResolvedValue(`${B1},${B2}`);
    sMembers.mockImplementation(() => Promise.reject(new Error('Redis connection lost')));

    const queue = await checkoutQueue('images_v6:Update', false, false);
    expect(queue.content).toEqual([]);
    await queue.commit();

    // readBuckets is empty → commit() short-circuits: no del, no bucket-list
    // rewrite (the only hSet allowed is the checkout-time append, never a commit
    // rewrite that would drop B1/B2).
    expect(del).not.toHaveBeenCalled();
    expect(hSet).not.toHaveBeenCalledWith('queues:buckets', 'images_v6:Update', '');
  });

  it('checkoutQueue: a degraded getBucketNames read aborts the checkout — no append write, no delete', async () => {
    hGet.mockImplementation(() => Promise.reject(new Error('Redis connection lost')));

    const queue = await checkoutQueue('images_v6:Update', false, false);
    expect(queue.content).toEqual([]);
    await queue.commit();

    // Can't read the bucket list → process nothing, write nothing, delete nothing.
    expect(hSet).not.toHaveBeenCalled();
    expect(sMembers).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('addToQueue: a degraded getBucketNames read SKIPS the enqueue (does not overwrite/orphan existing buckets)', async () => {
    // Pre-existing buckets exist in reality, but the bucket-list read fails open
    // (false-empty). Writing a fresh single-bucket reference would orphan them.
    hGet.mockImplementation(() => Promise.reject(new Error('Redis connection lost')));

    await addToQueue('images_v6:Update', [1, 2, 3]);

    expect(hSet).not.toHaveBeenCalled(); // no clobbering bucket-list overwrite
    expect(sAdd).not.toHaveBeenCalled(); // no write into a guessed bucket
    expect(logSysRedisFailOpen).toHaveBeenCalledWith(
      'write-degraded',
      'queues.addToQueue skipped-degraded-read',
      expect.any(Error),
      expect.objectContaining({ key: 'images_v6:Update' })
    );
  });

  it('checkoutQueue happy path (all reads succeed): retires exactly the processed buckets', async () => {
    // Guards that the non-destructive gating did not break the normal commit:
    // when both reads succeed, both buckets are deleted and dropped from the list.
    hGet.mockResolvedValue(`${B1},${B2}`);
    sMembers.mockImplementation((bucket?: string) =>
      Promise.resolve(bucket === B1 ? ['1'] : ['2'])
    );

    const queue = await checkoutQueue('images_v6:Update', false, false);
    expect(new Set(queue.content)).toEqual(new Set([1, 2]));
    await queue.commit();

    expect(del).toHaveBeenCalledWith([B1, B2]);
    // Both retired → the rewritten list no longer references them.
    expect(hSet).toHaveBeenCalledWith('queues:buckets', 'images_v6:Update', '');
  });
});

// ---------------------------------------------------------------------------
// The Postgres parking lot (see FALLBACK_KEY_PREFIX in queues.ts).
//
// A dropped enqueue used to be silently unrecoverable for Delete keys — nothing
// re-derives a delete from a row that is already gone, so the search document
// survived forever. These assert the ids reach durable storage and come back out,
// because a revert of that behaviour is otherwise invisible: addToQueue swallows
// everything by design, so no failure surfaces at the call site.
// ---------------------------------------------------------------------------
describe('dropped-enqueue parking lot', () => {
  const DOWN = () => Promise.reject(new Error('Redis connection lost'));
  const PARKED_KEY = 'search-index-queue-fallback:images_v6:Delete';
  const parkPayload = (call: unknown[]) =>
    call.slice(1).find((v) => typeof v === 'string' && (v as string).startsWith('[')) as string;

  it('parks the ids in Postgres when the bucket-list read is degraded', async () => {
    hGet.mockImplementation(DOWN);

    await expect(addToQueue('images_v6:Delete', [7, 8, 9])).resolves.toBe(false);

    const inserts = callsMatching(queryRaw, 'INSERT INTO "KeyValue"');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].slice(1)).toContain(PARKED_KEY);
    expect(parkPayload(inserts[0])).toBe(JSON.stringify([7, 8, 9]));
  });

  it('parks only the chunks that actually failed', async () => {
    hGet.mockResolvedValue(BUCKETS_CSV);
    let call = 0;
    sAdd.mockImplementation(() =>
      ++call === 2 ? Promise.reject(new Error('down')) : Promise.resolve(1)
    );
    const ids = Array.from({ length: 25000 }, (_, i) => i + 1);

    await expect(addToQueue('images_v6:Delete', ids)).resolves.toBe(false);

    const inserts = callsMatching(queryRaw, 'INSERT INTO "KeyValue"');
    expect(inserts).toHaveLength(1);
    const parked = JSON.parse(parkPayload(inserts[0]));
    expect(parked).toHaveLength(10000);
    expect(parked[0]).toBe(10001); // the second chunk, not the first or third
  });

  it('does not touch Postgres on a healthy enqueue', async () => {
    hGet.mockResolvedValue(BUCKETS_CSV);
    await expect(addToQueue('images_v6:Delete', [1, 2, 3])).resolves.toBe(true);
    expect(queryRaw).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('reports the cap so a full parking lot is not a silent discard', async () => {
    hGet.mockImplementation(DOWN);
    queryRaw.mockResolvedValue([{ capped: true }]);

    await addToQueue('images_v6:Delete', [1, 2, 3]);

    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'search-index-queue-fallback',
        message: expect.stringContaining('cap'),
      })
    );
  });

  describe('drain', () => {
    const parkedRow = (value: unknown) => [{ key: PARKED_KEY, value }];
    // The SELECT and the parking INSERT share the queryRaw mock; route by statement.
    const withParked = (value: unknown) =>
      queryRaw.mockImplementation((...call: unknown[]) =>
        Promise.resolve(sqlOf(call).includes('SELECT "key", "value"') ? parkedRow(value) : [])
      );

    it('replays parked ids and then deletes the row it replayed', async () => {
      withParked([4, 5]);
      hGet.mockResolvedValue(BUCKETS_CSV);

      await expect(drainDroppedEnqueues()).resolves.toEqual({
        keys: 1,
        replayed: 2,
        reparked: 0,
      });
      expect(sAdd).toHaveBeenCalledWith(BUCKETS_CSV, ['4', '5']);

      // Deleted by key AND by the length it replayed, so a drop that landed between the
      // read and the delete is not swallowed along with it.
      const deletes = callsMatching(executeRaw, 'DELETE FROM "KeyValue"');
      expect(deletes).toHaveLength(1);
      expect(deletes[0].slice(1)).toEqual([PARKED_KEY, 2]);
    });

    it('leaves the row parked when the replay fails, and does not park a second copy', async () => {
      withParked([4, 5]);
      hGet.mockImplementation(DOWN);

      await expect(drainDroppedEnqueues()).resolves.toEqual({
        keys: 1,
        replayed: 0,
        reparked: 2,
      });
      // The row is still there — deleting it before a successful replay is what would
      // lose the ids, and re-inserting would duplicate them.
      expect(callsMatching(executeRaw, 'DELETE FROM "KeyValue"')).toHaveLength(0);
      expect(callsMatching(queryRaw, 'INSERT INTO "KeyValue"')).toHaveLength(0);
    });

    it('drops a row whose value is not an array rather than retrying it forever', async () => {
      withParked({ not: 'an array' });
      hGet.mockResolvedValue(BUCKETS_CSV);

      await expect(drainDroppedEnqueues()).resolves.toEqual({
        keys: 1,
        replayed: 0,
        reparked: 0,
      });
      const deletes = callsMatching(executeRaw, 'jsonb_typeof("value") <> \'array\'');
      expect(deletes).toHaveLength(1);
      expect(sAdd).not.toHaveBeenCalled();
    });
  });
});
