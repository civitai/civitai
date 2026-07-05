import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Behavioral coverage for countNotifications' per-key request coalescing (single-flight). The heaviest read
// on the DB used to fire N concurrent identical `GROUP BY category` scans for the same user (a 43-way
// thundering herd was observed) because there was no dedup around the query. countNotifications now shares
// ONE in-flight execution + result across all concurrent same-key callers, cleaning the map on settle.
//
// Same "fake pool + deferred drives control flow" idiom as operations.markNotificationsRead.test.ts. We
// assert on `db.cancellableQuery` invocation COUNT (the underlying work) and the shared/independent result,
// and on the exported `countInFlight` map for cleanup. NOTE the semantic contrast with mark-read: reads
// COALESCE (share the one promise) rather than SERIALIZE (chain) — two same-key calls must run the query
// ONCE, not twice-in-sequence.

// ---- Shared hoisted mock state (vi.mock factories hoist above imports; see operations.test.ts) ----------
const h = vi.hoisted(() => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const state: {
    // Resolver for the pending cancellableQuery result — lets a test hold the DB query "in flight".
    resultImpl: ((sql: string, params?: unknown[], i?: number) => Promise<unknown[]>) | null;
    // Cache behavior (default: always a miss, so the DB query runs).
    getUser: (userId: number) => Promise<unknown[] | undefined>;
    isWritePool: boolean;
  } = { resultImpl: null, getUser: async () => undefined, isWritePool: false };

  const readPool = {
    cancellableQuery: (sql: string, params?: unknown[]) => {
      const i = calls.length;
      calls.push({ sql, params });
      return { result: async () => state.resultImpl!(sql, params, i) };
    },
  };
  return { calls, state, readPool };
});

vi.mock('./lag', () => ({
  getNotifDbWithoutLag: async () => h.readPool,
  isWritePool: () => h.state.isWritePool,
  preventReplicationLag: vi.fn(async () => {}),
}));
vi.mock('./clients/db', () => ({ notifDbWrite: () => h.readPool, notifDbRead: () => h.readPool }));
vi.mock('./cache', () => ({
  notificationCache: {
    getUser: (userId: number) => h.state.getUser(userId),
    setUser: vi.fn(async () => {}),
    bustUser: vi.fn(async () => {}),
  },
}));

import { countNotifications, countInFlight } from './operations';

// One macrotask hop flushes all currently-queued microtasks — enough to advance the count path up to its
// pending cancellableQuery.result().
const tick = () => new Promise<void>((r) => setImmediate(r));

// Deferred whose resolution we control — used to hold the DB query "in flight".
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  countInFlight.clear();
  h.calls.length = 0;
  h.state.getUser = async () => undefined; // cache miss by default
  h.state.isWritePool = false;
  h.state.resultImpl = async () => [{ category: 'Comment', count: 3 }];
});

afterEach(() => {
  vi.useRealTimers();
});

// =========================================================================================================
describe('per-key coalescing (single-flight)', () => {
  it('collapses two concurrent SAME-key calls into ONE DB query and hands both the same result', async () => {
    const d = deferred<unknown[]>();
    h.state.resultImpl = () => d.promise;

    const p1 = countNotifications({ userId: 1, unread: true });
    const p2 = countNotifications({ userId: 1, unread: true });

    await tick();
    // The query fired exactly once even though two callers are waiting — this is the herd collapse.
    expect(h.calls).toHaveLength(1);
    // Both callers share the identical in-flight promise.
    expect(p2).toBe(p1);

    const rows = [{ category: 'Comment', count: 7 }];
    d.resolve(rows);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(rows);
    expect(r2).toEqual(rows);
    // Still exactly one query after settle.
    expect(h.calls).toHaveLength(1);
  });

  it('does NOT coalesce DIFFERENT keys — distinct userId / unread / category run independently', async () => {
    const dA = deferred<unknown[]>();
    const dB = deferred<unknown[]>();
    const dD = deferred<unknown[]>();
    const byUnreadCat = new Map<string, ReturnType<typeof deferred<unknown[]>>>();
    h.state.resultImpl = (_sql, params) => {
      const p = params ?? [];
      const k = `${p[0]}:${p.length > 1 ? p[1] : 'all'}`;
      return byUnreadCat.get(k)!.promise;
    };

    // Different userId, different unread, different category — none should share.
    byUnreadCat.set('1:all', dA); // userId 1, unread true, no category
    byUnreadCat.set('2:all', dB); // userId 2
    byUnreadCat.set('1:System', dD); // userId 1, category System

    countNotifications({ userId: 1, unread: true });
    countNotifications({ userId: 2, unread: true });
    countNotifications({ userId: 1, unread: true, category: 'System' });

    await tick();
    // Three independent queries in flight simultaneously — no cross-key collapse.
    expect(h.calls).toHaveLength(3);
    expect(countInFlight.size).toBe(3);

    dA.resolve([]);
    dB.resolve([]);
    dD.resolve([]);
    await tick();
  });

  it('distinguishes the SAME userId on the unread flag alone (different key)', async () => {
    const pending = deferred<unknown[]>();
    h.state.resultImpl = () => pending.promise; // hold every query in flight

    countNotifications({ userId: 5, unread: true });
    countNotifications({ userId: 5, unread: false });

    await tick();
    expect(h.calls).toHaveLength(2); // unread:true vs unread:false are NOT the same key
    expect(countInFlight.size).toBe(2);
    pending.resolve([]);
    await tick();
  });

  it('re-runs the query on a subsequent call AFTER the in-flight promise settles (map cleaned up)', async () => {
    const d1 = deferred<unknown[]>();
    h.state.resultImpl = () => d1.promise;

    const p1 = countNotifications({ userId: 9, unread: true });
    await tick();
    expect(h.calls).toHaveLength(1);
    expect(countInFlight.has('9:true:all')).toBe(true);

    d1.resolve([{ category: 'Comment', count: 1 }]);
    await p1;
    await tick(); // let the .finally cleanup run
    expect(countInFlight.has('9:true:all')).toBe(false);

    // A fresh call re-derives — it launches a NEW query rather than reusing the settled promise.
    h.state.resultImpl = async () => [{ category: 'Comment', count: 2 }];
    await countNotifications({ userId: 9, unread: true });
    expect(h.calls).toHaveLength(2);
  });

  it('propagates a rejection to ALL awaiters and cleans up the key so the next call proceeds', async () => {
    const d = deferred<unknown[]>();
    h.state.resultImpl = () => d.promise;

    const p1 = countNotifications({ userId: 3, unread: true });
    const p2 = countNotifications({ userId: 3, unread: true });
    await tick();
    expect(h.calls).toHaveLength(1);
    expect(p2).toBe(p1);

    d.reject(new Error('query boom'));
    await expect(p1).rejects.toThrow('query boom');
    await expect(p2).rejects.toThrow('query boom'); // both awaiters rejected, not just the first
    await tick(); // .finally cleanup
    expect(countInFlight.has('3:true:all')).toBe(false); // key not poisoned

    // Next call proceeds normally (new query), unaffected by the prior failure.
    h.state.resultImpl = async () => [{ category: 'Comment', count: 4 }];
    const rows = await countNotifications({ userId: 3, unread: true });
    expect(rows).toEqual([{ category: 'Comment', count: 4 }]);
    expect(h.calls).toHaveLength(2);
  });
});

// =========================================================================================================
describe('cache-hit path under coalescing', () => {
  it('returns the cached value WITHOUT a DB query (still safe to coalesce)', async () => {
    const cached = [{ category: 'System', count: 5 }];
    h.state.getUser = async () => cached;

    const result = await countNotifications({ userId: 11, unread: true });
    expect(result).toBe(cached);
    expect(h.calls).toHaveLength(0); // no DB query on a cache hit
    await tick();
    expect(countInFlight.has('11:true:all')).toBe(false); // fast path cleans up too
  });

  it('two concurrent same-key cache-hit calls still only resolve the cache once (shared promise)', async () => {
    const d = deferred<unknown[]>();
    h.state.getUser = () => d.promise as Promise<unknown[]>;

    const p1 = countNotifications({ userId: 12, unread: true });
    const p2 = countNotifications({ userId: 12, unread: true });
    expect(p2).toBe(p1); // coalesced even though the impl returns before the DB

    const cached = [{ category: 'Comment', count: 9 }];
    d.resolve(cached);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(cached);
    expect(r2).toBe(cached);
    expect(h.calls).toHaveLength(0);
  });
});
