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
    // The FLAG repeats too. Its TTL is REPLICATION_LAG_DELAY seconds while a sweep runs for minutes,
    // so a sweep-wide "already flagged this user" cache would leave every later batch of theirs
    // reading the replica — which is the window the flag exists to narrow.
    expect(markFresh.mock.calls.map(([id]) => id)).toEqual([7, 7]);
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
    // because the number looks arbitrary, the number is the point. Leave the 25 as a literal too:
    // asserting toBe(CLEANUP_BUST_CONCURRENCY) would agree with the source at every width, including
    // no cap at all.
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
    // Covers the fullness gate that stops on a FULL batch; the two-batch test above covers the one
    // that stops on a short batch. Neither is redundant with the other.
    // DISTINCT users, not one user repeated: a full batch in production carries thousands of them,
    // and a bust list truncated to some "reasonable" cap would pass a fixture that dedupes to one.
    batches.push(
      Array.from({ length: CLEANUP_BATCH_SIZE }, (_, i) => ({ userId: i + 1, viewed: false }))
    );
    batches.push([{ userId: CLEANUP_BATCH_SIZE + 1, viewed: false }]);

    const deleted = await cleanupNotifications(before);

    expect(deleted).toBe(CLEANUP_BATCH_SIZE + 1);
    expect(bustUser).toHaveBeenCalledTimes(CLEANUP_BATCH_SIZE + 1);
    expect(bustedIds()).toContain(CLEANUP_BATCH_SIZE + 1);
  });

  it('deletes with RETURNING so the unread filter has something to filter on', async () => {
    batches.push([{ userId: 9, viewed: false }]);

    await cleanupNotifications(before);

    // The WHOLE statement, by equality, and every literal spelled out rather than interpolated from
    // the constants the SQL itself uses. The fake pool never executes SQL, so this assertion is the
    // only thing standing between the suite and a sweep that deletes the newest rows, deletes from
    // the wrong table, deletes without a limit, or returns an inverted `viewed`. Fragment guards were
    // tried first and each one left a green mutation beside it; `toContain` cannot see an insertion,
    // and a limit derived from CLEANUP_BATCH_SIZE moves with the constant it is meant to pin.
    expect(captured[0].sql.replace(/\s+/g, ' ').trim()).toBe(
      'DELETE FROM "UserNotification" WHERE id IN (SELECT id FROM "UserNotification" WHERE "createdAt" < $1 LIMIT 10000) RETURNING "userId", viewed'
    );
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

  it('attempts every user in the batch even when redis is down for all of them', async () => {
    // MORE users than workers, and EVERY bust rejecting. Workers pull from a shared cursor, so a
    // worker that gave up on an error would not strand a queue of its own — it would retire, and the
    // users past the 25th would simply never be reached. With one rejection that is invisible,
    // because the other 24 workers drain the cursor between them.
    const userIds = Array.from({ length: 30 }, (_, i) => i + 500);
    bustUser.mockRejectedValue(new Error('redis down'));
    batches.push(userIds.map((userId) => ({ userId, viewed: false })));

    await cleanupNotifications(before);

    expect(bustedIds().sort((a, b) => a - b)).toEqual(userIds);
    expect(logged[0]).toMatchObject({ bustsAcked: 0 });
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
