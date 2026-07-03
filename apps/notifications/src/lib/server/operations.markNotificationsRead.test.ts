import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Behavioral coverage for markNotificationsRead (closes G3 from the 2026-07-03 coverage audit). The
// sibling operations.test.ts only asserts the read-path SQL *string*; this suite exercises the two things
// markNotificationsRead exists to do and that had ZERO behavioral coverage:
//   1. the per-user promise-chain queue — the rapid-click pool-starvation guard that serializes concurrent
//      mark-reads for the SAME user (never >1 pool acquire per user per pod) while letting DIFFERENT users
//      run concurrently, and
//   2. the transient-error backoff/retry loop (retry a transient pool-acquire error up to
//      MARK_READ_MAX_ATTEMPTS, do NOT retry a non-transient error).
// Same "fake pool drives control flow" idiom as poll-loop.behavioral.test.ts. `markNotificationsRead`
// returns void, so its settle promise is unreachable — we await the exported `userWriteQueues` chain.

// ---- Shared hoisted mock state (vi.mock factories hoist above imports; see operations.test.ts) ----------
const h = vi.hoisted(() => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const state: {
    // (sql, params, callIndex) => the result of write.query(). Default set in beforeEach.
    queryImpl: ((sql: string, params: unknown[], i: number) => Promise<{ rowCount: number }>) | null;
    // Row returned by the category-lookup cancellableQuery in the single-id path.
    catRows: Array<{ category: string }>;
  } = { queryImpl: null, catRows: [{ category: 'Comment' }] };

  const writePool = {
    // The mark-read UPDATE(s) go through .query — recorded + driven by state.queryImpl.
    query: (sql: string, params: unknown[]) => {
      const i = calls.length;
      calls.push({ sql, params });
      return state.queryImpl!(sql, params, i);
    },
    // Only the single-id path's category lookup uses cancellableQuery.
    cancellableQuery: (_sql: string, _params: unknown[]) => ({
      result: async () => state.catRows,
    }),
  };
  return { calls, state, writePool };
});

vi.mock('./clients/db', () => ({
  notifDbWrite: () => h.writePool,
  notifDbRead: () => h.writePool,
}));
// getNotifDbWithoutLag feeds the single-id category lookup; return the same fake pool.
vi.mock('./lag', () => ({
  getNotifDbWithoutLag: async () => h.writePool,
  isWritePool: () => true,
  preventReplicationLag: vi.fn(async () => {}),
}));
vi.mock('./cache', () => ({
  notificationCache: {
    bustUser: vi.fn(async () => {}),
    clearCategory: vi.fn(async () => {}),
    decrementUser: vi.fn(async () => {}),
  },
}));
vi.mock('./clients/axiom', () => ({
  logToAxiom: vi.fn(async () => {}),
  safeError: (e: unknown) => ({ message: String(e) }),
}));

import { markNotificationsRead, userWriteQueues } from './operations';
import { notificationCache } from './cache';
import { preventReplicationLag } from './lag';

// Drain the microtask queue (real timers only). One macrotask hop flushes all currently-queued
// microtasks, which is enough for the mark-read chain (its only async boundaries are microtasks up to the
// pending write.query).
const tick = () => new Promise<void>((r) => setImmediate(r));

// Deferred whose resolution we control — used to prove call B waits on call A.
function deferred() {
  let resolve!: (v: { rowCount: number }) => void;
  const promise = new Promise<{ rowCount: number }>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  userWriteQueues.clear();
  h.calls.length = 0;
  h.state.queryImpl = async () => ({ rowCount: 1 });
  h.state.catRows = [{ category: 'Comment' }];
});

afterEach(() => {
  vi.useRealTimers();
});

// =========================================================================================================
describe('per-user serialization (pool-starvation guard)', () => {
  it('serializes two concurrent mark-reads for the SAME user — B waits for A to settle', async () => {
    const a = deferred();
    const b = deferred();
    const deferreds = [a, b];
    h.state.queryImpl = (_sql, _params, i) => deferreds[i].promise;

    markNotificationsRead({ userId: 1, all: true });
    markNotificationsRead({ userId: 1, all: true });
    const chain = userWriteQueues.get(1)!; // the tail promise for user 1

    await tick();
    // Only A's UPDATE has been issued; B is chained behind A and has NOT acquired the pool yet.
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].params).toEqual([1]);

    a.resolve({ rowCount: 1 }); // A settles → B is released
    await tick();
    expect(h.calls).toHaveLength(2); // now B runs
    expect(h.calls[1].params).toEqual([1]);

    b.resolve({ rowCount: 1 });
    await chain; // drain (no unhandled rejections)
  });

  it('runs mark-reads for DIFFERENT users concurrently — they do not serialize against each other', async () => {
    const d1 = deferred();
    const d2 = deferred();
    // Both queries block; if the two users shared a chain, only one would have fired.
    const byUser = new Map<number, ReturnType<typeof deferred>>([
      [1, d1],
      [2, d2],
    ]);
    h.state.queryImpl = (_sql, params) => byUser.get(params[0] as number)!.promise;

    markNotificationsRead({ userId: 1, all: true });
    markNotificationsRead({ userId: 2, all: true });
    const chain1 = userWriteQueues.get(1)!;
    const chain2 = userWriteQueues.get(2)!;

    await tick();
    // Both UPDATEs are in flight simultaneously — one user's pending write does not block the other.
    expect(h.calls).toHaveLength(2);
    expect(new Set(h.calls.map((c) => c.params[0]))).toEqual(new Set([1, 2]));

    d1.resolve({ rowCount: 1 });
    d2.resolve({ rowCount: 1 });
    await Promise.all([chain1, chain2]);
  });

  it('prunes the per-user chain entry once the last enqueued write settles (no unbounded growth)', async () => {
    markNotificationsRead({ userId: 42, all: true });
    const chain = userWriteQueues.get(42)!;
    expect(userWriteQueues.has(42)).toBe(true);

    await chain;
    await tick(); // let the .finally cleanup callback run
    expect(userWriteQueues.has(42)).toBe(false);
  });

  it('does NOT poison the chain: a failed write still lets the next queued call for that user proceed', async () => {
    let n = 0;
    h.state.queryImpl = async () => {
      n++;
      if (n === 1) throw new Error('some non-transient failure'); // first call fails hard
      return { rowCount: 1 };
    };

    markNotificationsRead({ userId: 8, all: true });
    markNotificationsRead({ userId: 8, all: true });
    const chain = userWriteQueues.get(8)!;

    await chain;
    await tick();
    // Second call ran despite the first throwing (the chain swallows per-attempt errors, never rejects).
    expect(n).toBe(2);
    expect(userWriteQueues.has(8)).toBe(false);
  });
});

// =========================================================================================================
describe('transient-error retry / backoff', () => {
  it('retries a transient pool-acquire error with backoff, then succeeds', async () => {
    vi.useFakeTimers();
    let n = 0;
    h.state.queryImpl = async () => {
      n++;
      if (n < 3) throw new Error('timeout exceeded when trying to connect (pool full)');
      return { rowCount: 1 };
    };

    markNotificationsRead({ userId: 5, all: true });
    const chain = userWriteQueues.get(5)!;

    await vi.advanceTimersByTimeAsync(10_000); // covers the 200ms/600ms backoffs (+ jitter)
    await chain;

    expect(n).toBe(3); // 2 transient failures + 1 success
  });

  it('does NOT retry a non-transient error — surfaces (returns) on the first attempt', async () => {
    let n = 0;
    h.state.queryImpl = async () => {
      n++;
      throw new Error('duplicate key value violates unique constraint');
    };

    markNotificationsRead({ userId: 6, all: true });
    const chain = userWriteQueues.get(6)!;

    await chain; // no timers needed: a non-transient error breaks out immediately
    expect(n).toBe(1);
  });

  it('gives up after MARK_READ_MAX_ATTEMPTS when the transient error never clears', async () => {
    vi.useFakeTimers();
    let n = 0;
    h.state.queryImpl = async () => {
      n++;
      throw new Error('Disconnects client'); // transient, but permanent here
    };

    markNotificationsRead({ userId: 7, all: true });
    const chain = userWriteQueues.get(7)!;

    await vi.advanceTimersByTimeAsync(60_000);
    await chain; // never rejects even on exhaustion (fire-and-forget contract)

    expect(n).toBe(4); // MARK_READ_MAX_ATTEMPTS
  });
});

// =========================================================================================================
describe('markReadImpl branches + SQL/param indexing', () => {
  it('all + category: category-scoped UPDATE ($2 cast) and clears just that category', async () => {
    markNotificationsRead({ userId: 3, all: true, category: 'Comment' });
    await userWriteQueues.get(3)!;

    expect(h.calls).toHaveLength(1);
    const { sql, params } = h.calls[0];
    expect(sql).toContain('SET viewed = TRUE');
    expect(sql).toContain('un."userId" = $1');
    expect(sql).toContain('n."category" = $2::"NotificationCategory"');
    expect(params).toEqual([3, 'Comment']);
    expect(notificationCache.clearCategory).toHaveBeenCalledWith(3, 'Comment');
    expect(notificationCache.bustUser).not.toHaveBeenCalled();
    expect(preventReplicationLag).toHaveBeenCalledWith(3);
  });

  it('all, no category: bulk UPDATE keyed on userId and busts the whole user cache', async () => {
    markNotificationsRead({ userId: 3, all: true });
    await userWriteQueues.get(3)!;

    expect(h.calls).toHaveLength(1);
    const { sql, params } = h.calls[0];
    expect(sql).toContain('un."userId" = $1 AND un.viewed IS FALSE');
    expect(sql).not.toContain('category');
    expect(params).toEqual([3]);
    expect(notificationCache.bustUser).toHaveBeenCalledWith(3);
    expect(notificationCache.clearCategory).not.toHaveBeenCalled();
  });

  it('single id: UPDATE by id, then looks up the category and decrements the cache when a row changed', async () => {
    h.state.queryImpl = async () => ({ rowCount: 1 });
    h.state.catRows = [{ category: 'Comment' }];

    markNotificationsRead({ userId: 4, id: 99 });
    await userWriteQueues.get(4)!;

    expect(h.calls).toHaveLength(1);
    const { sql, params } = h.calls[0];
    expect(sql).toContain('WHERE id = $1 AND viewed IS FALSE');
    expect(params).toEqual([99]);
    expect(notificationCache.decrementUser).toHaveBeenCalledWith(4, 'Comment');
    expect(notificationCache.bustUser).not.toHaveBeenCalled();
  });

  it('single id, no row changed (rowCount 0): no category lookup, no cache decrement', async () => {
    h.state.queryImpl = async () => ({ rowCount: 0 });

    markNotificationsRead({ userId: 4, id: 99 });
    await userWriteQueues.get(4)!;

    expect(h.calls).toHaveLength(1);
    expect(notificationCache.decrementUser).not.toHaveBeenCalled();
    expect(preventReplicationLag).not.toHaveBeenCalled();
  });
});
