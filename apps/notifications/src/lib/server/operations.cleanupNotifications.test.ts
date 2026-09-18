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

import { cleanupNotifications, CLEANUP_BATCH_SIZE } from './operations';
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
      { userId: 3, viewed: true },
      { userId: 3, viewed: false }, // read row FIRST: deduping before the filter would drop this user
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
    // Each user's OWN flag, not one flag for the batch: with a single user in the batch, flagging
    // userIds[0] every time is indistinguishable from flagging the right one.
    expect(markFresh.mock.calls.map(([id]) => id).sort((a, b) => a - b)).toEqual(userIds);
  });

  it('never has more than CLEANUP_BUST_CONCURRENCY busts in flight', async () => {
    // The width cap is the only thing between one batch and thousands of simultaneous redis
    // round-trips, and it is invisible to every other assertion here: replace the pool with an
    // unbounded `Promise.all(userIds.map(...))` and they all still pass. If you are deleting this
    // because the number looks arbitrary, the number is the point.
    let inFlight = 0;
    let peak = 0;
    const track = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight--;
    };
    // BOTH redis calls, because the cap's own comment prices a busted user at two round-trips: hoist
    // the lag flags out of the pool and they go out 60-at-a-time while the DEL half stays capped.
    bustUser.mockImplementation(track);
    markFresh.mockImplementation(track);
    // TWO batches, because the cap is per sweep, not per batch: drop the await on the bust pass and
    // batch two's pool runs alongside batch one's while every other assertion here still passes.
    batches.push(Array.from({ length: 60 }, (_, i) => ({ userId: i + 200, viewed: false })));
    batches.push(Array.from({ length: 60 }, (_, i) => ({ userId: i + 400, viewed: false })));

    await cleanupNotifications(before);

    expect(peak).toBe(25);
  });

  it('keeps busting after a batch that came back full', async () => {
    // Every other batch here is a handful of rows, so anything gated on batch fullness — a sweep that
    // busts the first batch and silently stops — is invisible to them.
    batches.push(Array.from({ length: CLEANUP_BATCH_SIZE }, () => ({ userId: 1, viewed: false })));
    batches.push([{ userId: 2, viewed: false }]);

    const deleted = await cleanupNotifications(before);

    expect(deleted).toBe(CLEANUP_BATCH_SIZE + 1);
    expect(bustedIds().sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('deletes with RETURNING so the unread filter has something to filter on', async () => {
    batches.push([{ userId: 9, viewed: false }]);

    await cleanupNotifications(before);

    // Anchored, not toContain: `RETURNING "userId", viewed IS FALSE AS viewed` CONTAINS the plain
    // form, and would hand every row an inverted `viewed` — busting the read users and no one else.
    expect(captured[0].sql.trimEnd()).toMatch(/RETURNING "userId", viewed$/);
    expect(captured[0].params).toEqual([before.toISOString()]);
    // The fake pool answers every query identically, so without these the sweep could delete the
    // NEWEST rows, or none at all, and every test here would still pass.
    expect(captured[0].sql).toContain('"createdAt" < $1');
    expect(captured[0].sql).toContain(`LIMIT ${CLEANUP_BATCH_SIZE}`);
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
    // A second populated batch, because the count accumulates: with one batch, `bustsAcked =` and
    // `bustsAcked +=` report the same number.
    batches.push([{ userId: 3, viewed: false }]);

    await cleanupNotifications(before);

    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ name: 'notification.cleanup', deleted: 3, bustsAcked: 2 });
  });
});
