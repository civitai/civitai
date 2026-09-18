import { describe, expect, it, vi, beforeEach } from 'vitest';

// The cleanup sweep with a fake write pool: each `query` call returns the next programmed batch of
// deleted rows, so the batch loop, the unread filter and the per-user cache bust are all observable
// without a DB or a redis.
const { captured, batches, fakePool, calls, logged } = vi.hoisted(() => {
  const captured: Array<{ sql: string; params?: unknown[] }> = [];
  const logged: Array<Record<string, unknown>> = [];
  const batches: Array<Array<{ userId: number; viewed: boolean }>> = [];
  // Ordered log of every cache/lag call, so "flagged before busted" is assertable and not assumed.
  const calls: string[] = [];
  const fakePool = {
    query: async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      const rows = batches.shift() ?? [];
      return { rows, rowCount: rows.length };
    },
  };
  return { captured, batches, fakePool, calls, logged };
});

vi.mock('./clients/db', () => ({ notifDbWrite: () => fakePool, notifDbRead: () => fakePool }));
vi.mock('./clients/axiom', () => ({
  logToAxiom: async (data: Record<string, unknown>) => {
    logged.push(data);
  },
  safeError: (e: unknown) => e,
}));
// Only the cache calls the cleanup path itself makes. A test for another operation added to this file
// will need more of notificationCache — countNotificationsImpl reaches getUser and setUser.
vi.mock('./cache', () => ({
  notificationCache: {
    bustUser: vi.fn(async () => undefined),
    clearCategory: vi.fn(async () => undefined),
    decrementUser: vi.fn(async () => undefined),
  },
}));
vi.mock('./lag', () => ({
  preventReplicationLag: vi.fn(),
  getNotifDbWithoutLag: async () => fakePool,
  isWritePool: () => false,
}));

import { cleanupNotifications } from './operations';
import { notificationCache } from './cache';
import { preventReplicationLag } from './lag';

const before = new Date('2025-09-01T00:00:00.000Z');
const bustUser = vi.mocked(notificationCache.bustUser);
const markFresh = vi.mocked(preventReplicationLag);
const bustedIds = () => bustUser.mock.calls.map(([id]) => id);

beforeEach(() => {
  captured.length = 0;
  batches.length = 0;
  calls.length = 0;
  logged.length = 0;
  // mockReset, not mockClear: a `mockRejectedValueOnce` queued by one test survives mockClear and
  // would poison the first bust of the next one.
  bustUser.mockReset().mockImplementation(async (userId: number) => {
    calls.push(`bust:${userId}`);
  });
  markFresh.mockReset().mockImplementation(async (userId: number) => {
    calls.push(`lag:${userId}`);
  });
});

describe('cleanupNotifications cache busting', () => {
  it('busts every user whose deleted row was unread, once each, and no one else', async () => {
    batches.push([
      { userId: 1, viewed: false },
      { userId: 1, viewed: false }, // same user twice in a batch -> one bust
      { userId: 2, viewed: true }, // read-only: the unread hash never counted it
      { userId: 3, viewed: false },
      { userId: 3, viewed: true }, // both kinds: still busted, once
    ]);

    const deleted = await cleanupNotifications(before);

    expect(deleted).toBe(5);
    expect(bustedIds().sort((a, b) => a - b)).toEqual([1, 3]);
  });

  it('busts a user again in a later batch — a bust is only the last word until the next delete', async () => {
    batches.push([{ userId: 7, viewed: false }]);
    batches.push([{ userId: 7, viewed: false }]);

    await cleanupNotifications(before);

    expect(bustedIds()).toEqual([7, 7]);
  });

  it('flags the replication-lag window BEFORE busting each user', async () => {
    // Order is the whole point: bust-then-flag leaves a count that reads the not-yet-replicated rows
    // and caches them for the full week, which is the bug this fix exists for. Do not reorder these.
    batches.push([{ userId: 5, viewed: false }]);

    await cleanupNotifications(before);

    expect(calls).toEqual(['lag:5', 'bust:5']);
  });

  it('busts every user in a batch larger than the concurrency width', async () => {
    // Exercises the worker pool's cursor: below the width each worker runs one user and the loop's
    // second iteration never executes, so an off-by-one there would be invisible.
    const userIds = Array.from({ length: 30 }, (_, i) => i + 100);
    batches.push(userIds.map((userId) => ({ userId, viewed: false })));

    await cleanupNotifications(before);

    expect(bustedIds().sort((a, b) => a - b)).toEqual(userIds);
  });

  it('never has more than CLEANUP_BUST_CONCURRENCY busts in flight', async () => {
    // The width cap is the only thing between one batch and thousands of simultaneous redis
    // round-trips, and it is invisible to every other assertion here: replace the pool with an
    // unbounded `Promise.all(userIds.map(...))` and they all still pass. If you are deleting this
    // because the number looks arbitrary, the number is the point.
    let inFlight = 0;
    let peak = 0;
    bustUser.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight--;
    });
    batches.push(Array.from({ length: 60 }, (_, i) => ({ userId: i + 200, viewed: false })));

    await cleanupNotifications(before);

    expect(peak).toBe(25);
  });

  it('deletes with RETURNING so the unread filter has something to filter on', async () => {
    batches.push([{ userId: 9, viewed: false }]);

    await cleanupNotifications(before);

    expect(captured[0].sql).toContain('RETURNING "userId", viewed');
    expect(captured[0].params).toEqual([before.toISOString()]);
  });

  it('stops on the first empty batch and sums the deleted rows across batches', async () => {
    batches.push([
      { userId: 1, viewed: false },
      { userId: 2, viewed: false },
    ]);
    batches.push([{ userId: 3, viewed: true }]);

    const deleted = await cleanupNotifications(before);

    expect(deleted).toBe(3);
    // Two populated batches plus the empty one that terminates the loop — never a fourth.
    expect(captured).toHaveLength(3);
  });

  it('keeps sweeping and keeps busting when redis rejects', async () => {
    // Both redis calls, because the lag flag is the one that fails FIRST in an outage: an unswallowed
    // rejection there would abort the sweep before a single bust ran.
    markFresh.mockRejectedValueOnce(new Error('redis down'));
    bustUser.mockRejectedValueOnce(new Error('redis down'));
    batches.push([{ userId: 1, viewed: false }]);
    batches.push([{ userId: 2, viewed: false }]);

    const deleted = await cleanupNotifications(before);

    expect(deleted).toBe(2);
    expect(bustedIds().sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('reports the busts redis acknowledged, not the ones attempted', async () => {
    // A sweep log that reads full while redis is dropping every DEL is the wrong tell to leave for
    // whoever reads it during the next incident.
    bustUser.mockRejectedValueOnce(new Error('redis down'));
    batches.push([
      { userId: 1, viewed: false },
      { userId: 2, viewed: false },
    ]);

    await cleanupNotifications(before);

    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ name: 'notification.cleanup', deleted: 2, bustsAcked: 1 });
  });
});
