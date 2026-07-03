import { beforeEach, describe, expect, it, vi } from 'vitest';

// queues.ts imports the real redis client module, which opens sockets at load.
// Mock it to an in-memory sysRedis whose hGet reply type (string vs Buffer) we
// control per-test — that's the exact axis of the original bug. The mock fns are
// created via vi.hoisted so they exist before vi.mock's hoisted factory
// references them.
// Everything referenced by a vi.mock factory must be hoisted (vi.mock is lifted
// to the top of the file). `state.deadlineDisabled` is a mutable holder tests
// flip to drop the deadline guard for the busy-loop cap test.
const { hGet, hSet, sAdd, sMembers, del, exists, set, withSysReadDeadline, logSysRedisFailOpen, state } =
  vi.hoisted(() => {
    // Real-ish wall-clock deadline race with a fixed short ms (env-independent).
    // Mirrors sys-read-deadline.ts so the SLOW/hang path is genuinely exercised:
    // a never-resolving op loses the race and rejects with a timeout error, which
    // queues.ts must catch and fail open.
    const DEADLINE_MS = 50;
    const holder = { deadlineDisabled: false };
    return {
      hGet: vi.fn(),
      hSet: vi.fn(() => Promise.resolve(1)),
      sAdd: vi.fn(() => Promise.resolve(1)),
      sMembers: vi.fn(() => Promise.resolve([] as string[])),
      del: vi.fn(() => Promise.resolve(1)),
      exists: vi.fn(() => Promise.resolve(0)),
      set: vi.fn(() => Promise.resolve('OK')),
      logSysRedisFailOpen: vi.fn(),
      state: holder,
      withSysReadDeadline: vi.fn(<T>(p: Promise<T>, ms: number = DEADLINE_MS): Promise<T> => {
        if (holder.deadlineDisabled || !ms || ms <= 0) return p;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`sysRedis read timed out after ${ms}ms`)), ms);
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

import { addToQueue, checkoutQueue, mergeQueue } from '~/server/redis/queues';

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
});

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
// The search-index queue is driven inline by content mutations. A sysRedis
// outage must NEVER 500 or hang the mutation — dropping an enqueue degrades to
// "content re-indexed on the next full reindex". Two failure modes:
//   - DOWN  → the sysRedis command REJECTS fast (try/catch catches it).
//   - SLOW  → the command PARKS forever (never rejects); only the deadline race
//             in withSysReadDeadline unblocks the caller.
// Every op must survive BOTH.
// ---------------------------------------------------------------------------
describe('queues fail-open — DOWN (sysRedis command rejects fast)', () => {
  const DOWN = () => Promise.reject(new Error('Redis connection lost'));

  it('addToQueue: a rejecting hGet read fails open — does not throw, mints+writes as empty queue', async () => {
    hGet.mockImplementation(DOWN); // getBucketNames read is DOWN

    await expect(addToQueue('images_v6:Update', [1, 2, 3])).resolves.toBeUndefined();
    // Fell open to "no buckets" → still attempts the best-effort writes.
    expect(hSet).toHaveBeenCalledTimes(1);
    expect(sAdd).toHaveBeenCalledTimes(1);
    expect(logSysRedisFailOpen).toHaveBeenCalledWith(
      'read-degraded',
      'queues.getBucketNames hGet',
      expect.any(Error),
      expect.objectContaining({ key: 'images_v6:Update' })
    );
  });

  it('addToQueue: a rejecting write (hSet/sAdd) is swallowed best-effort — does not throw', async () => {
    hGet.mockResolvedValue(null); // empty queue → mints a new bucket
    hSet.mockImplementation(DOWN);
    sAdd.mockImplementation(DOWN);

    await expect(addToQueue('images_v6:Update', [1, 2, 3])).resolves.toBeUndefined();
    expect(logSysRedisFailOpen).toHaveBeenCalledWith(
      'write-degraded',
      'queues.addToQueue hSet',
      expect.any(Error),
      expect.any(Object)
    );
    expect(logSysRedisFailOpen).toHaveBeenCalledWith(
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
  it('addToQueue: a HANGING hGet read is unblocked by the deadline race and fails open (does not hang/throw)', async () => {
    // A try/catch ALONE would not save this — the op never rejects. The deadline
    // race in withSysReadDeadline is the only thing that unblocks the caller.
    hGet.mockImplementation(never);

    await expect(addToQueue('images_v6:Update', [1, 2, 3])).resolves.toBeUndefined();
    expect(withSysReadDeadline).toHaveBeenCalled();
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

    await expect(addToQueue('images_v6:Update', [1, 2, 3])).resolves.toBeUndefined();
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
