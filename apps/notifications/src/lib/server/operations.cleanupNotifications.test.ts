import { describe, expect, it, vi, beforeEach } from 'vitest';

// The cleanup sweep with a fake write pool: each `query` call returns the next programmed batch of
// deleted rows, so the batch loop, the unread filter and the per-user cache bust are all observable
// without a DB or a redis.
const { captured, batches, fakePool, calls } = vi.hoisted(() => {
  const captured: Array<{ sql: string; params?: unknown[] }> = [];
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
  return { captured, batches, fakePool, calls };
});

vi.mock('./clients/db', () => ({ notifDbWrite: () => fakePool, notifDbRead: () => fakePool }));
vi.mock('./clients/axiom', () => ({
  logToAxiom: async () => undefined,
  logAxiomError: async () => undefined,
  safeError: (e: unknown) => e,
}));
vi.mock('./cache', () => ({
  notificationCache: {
    bustUser: vi.fn(async (userId: number) => {
      calls.push(`bust:${userId}`);
    }),
  },
}));
vi.mock('./lag', () => ({
  preventReplicationLag: vi.fn(async (userId: number) => {
    calls.push(`lag:${userId}`);
  }),
  getNotifDbWithoutLag: async () => fakePool,
  isWritePool: () => false,
}));

import { cleanupNotifications } from './operations';
import { notificationCache } from './cache';
import { preventReplicationLag } from './lag';

const before = new Date('2025-09-01T00:00:00.000Z');

beforeEach(() => {
  captured.length = 0;
  batches.length = 0;
  calls.length = 0;
  vi.mocked(notificationCache.bustUser).mockClear();
  vi.mocked(preventReplicationLag).mockClear();
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
    const busted = vi.mocked(notificationCache.bustUser).mock.calls.map(([id]) => id);
    expect(busted.sort()).toEqual([1, 3]);
  });

  it('busts a user again in a later batch — a bust is only the last word until the next delete', async () => {
    batches.push([{ userId: 7, viewed: false }]);
    batches.push([{ userId: 7, viewed: false }]);

    await cleanupNotifications(before);

    const busted = vi.mocked(notificationCache.bustUser).mock.calls.map(([id]) => id);
    expect(busted).toEqual([7, 7]);
  });

  it('flags the replication-lag window BEFORE busting each user', async () => {
    // Order is the whole point: bust-then-flag leaves a count that reads the not-yet-replicated rows
    // and caches them for the full week, which is the bug this fix exists for. Do not reorder these.
    batches.push([{ userId: 5, viewed: false }]);

    await cleanupNotifications(before);

    expect(calls).toEqual(['lag:5', 'bust:5']);
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

  it('keeps sweeping when redis is failing', async () => {
    vi.mocked(notificationCache.bustUser).mockRejectedValueOnce(new Error('redis down'));
    batches.push([{ userId: 1, viewed: false }]);
    batches.push([{ userId: 2, viewed: false }]);

    const deleted = await cleanupNotifications(before);

    expect(deleted).toBe(2);
  });
});
