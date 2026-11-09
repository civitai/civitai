import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const h = vi.hoisted(() => ({ notif: undefined as unknown as PGlite }));

vi.mock('./clients/db', () => {
  const pool = {
    query: (sql: string, params?: unknown[]) => h.notif.query(sql, params as unknown[]),
  };
  return { notifDbWrite: () => pool, notifDbRead: () => pool };
});
vi.mock('./lag', () => ({
  getNotifDbWithoutLag: vi.fn(),
  isWritePool: () => true,
  preventReplicationLag: vi.fn(async () => undefined),
}));
vi.mock('./cache', () => ({
  notificationCache: { decrementUser: vi.fn(async () => undefined) },
}));
vi.mock('./clients/axiom', () => ({ logToAxiom: vi.fn(async () => undefined), safeError: String }));

import { markNotificationsReadByKeys } from './operations';
import { notificationCache } from './cache';
import { preventReplicationLag } from './lag';

const ddl = fileURLToPath(
  new URL('../../../../../containers/notification-db/docker-init/01_all_ddl.sql', import.meta.url)
);

const OWNER = 7;
const OTHER = 8;
const keysFor = (imageId: number) =>
  [5, 10, 20, 50, 100].map((n) => `image-reaction-milestone:${imageId}:${n}`);

// [notificationId, key, category, userId, viewed]
const SEED: Array<[number, string, string, number, boolean]> = [
  [1, 'image-reaction-milestone:42:5', 'Milestone', OWNER, false],
  [2, 'image-reaction-milestone:42:10', 'Milestone', OWNER, false],
  [3, 'image-reaction-milestone:42:20', 'Milestone', OWNER, true],
  [4, 'image-reaction-milestone:43:5', 'Milestone', OWNER, false],
  [5, 'new-comment:1', 'Comment', OWNER, false],
  // Same notification row as id 1 delivered to a second user: only the caller's copy may change.
  [1, 'image-reaction-milestone:42:5', 'Milestone', OTHER, false],
];

async function viewed() {
  const { rows } = await h.notif.query<{ userId: number; notificationId: number; viewed: boolean }>(
    `SELECT "userId", "notificationId", viewed FROM "UserNotification" ORDER BY "userId", "notificationId"`
  );
  return rows.map((r) => `${r.userId}:${r.notificationId}:${r.viewed ? 'read' : 'unread'}`);
}

beforeEach(async () => {
  vi.clearAllMocks();
  h.notif = new PGlite();
  await h.notif.exec(readFileSync(ddl, 'utf8').replaceAll('CONCURRENTLY', ''));
  let unId = 100;
  for (const [id, key, category, userId, isViewed] of SEED) {
    await h.notif.query(
      `INSERT INTO "Notification" (id, type, key, category, details) VALUES ($1, 't', $2, $3, '{}')
       ON CONFLICT (id) DO NOTHING`,
      [id, key, category]
    );
    await h.notif.query(
      `INSERT INTO "UserNotification" (id, "notificationId", "userId", viewed) VALUES ($1, $2, $3, $4)`,
      [unId++, id, userId, isViewed]
    );
  }
});

describe('markNotificationsReadByKeys', () => {
  it("marks only the user's unread rows for those keys, and returns what it cleared", async () => {
    const cleared = await markNotificationsReadByKeys({ userId: OWNER, keys: keysFor(42) });

    expect(cleared).toEqual([{ category: 'Milestone', count: 2 }]);
    expect(await viewed()).toEqual([
      '7:1:read',
      '7:2:read',
      '7:3:read',
      '7:4:unread', // another image's milestone
      '7:5:unread', // not a key we asked for
      '8:1:unread', // another user's copy of the same notification
    ]);
    expect(notificationCache.decrementUser).toHaveBeenCalledWith(OWNER, 'Milestone', 2);
  });

  it('still reports and decrements what it cleared when the lag mark fails after the commit', async () => {
    vi.mocked(preventReplicationLag).mockRejectedValueOnce(new Error('redis down'));

    await expect(
      markNotificationsReadByKeys({ userId: OWNER, keys: keysFor(42) })
    ).resolves.toEqual([{ category: 'Milestone', count: 2 }]);
    expect(notificationCache.decrementUser).toHaveBeenCalledWith(OWNER, 'Milestone', 2);
  });

  it('returns nothing and leaves the cache alone when nothing was unread', async () => {
    await markNotificationsReadByKeys({ userId: OWNER, keys: keysFor(42) });
    vi.mocked(notificationCache.decrementUser).mockClear();

    expect(await markNotificationsReadByKeys({ userId: OWNER, keys: keysFor(42) })).toEqual([]);
    expect(notificationCache.decrementUser).not.toHaveBeenCalled();
  });
});
