import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type * as Db from './clients/db';

const h = vi.hoisted(() => ({
  notif: undefined as unknown as PGlite,
}));

vi.mock('./clients/db', async (importOriginal) => {
  const actual = await importOriginal<typeof Db>();
  const pool = {
    cancellableQuery: async (sql: string, params?: unknown[]) => ({
      result: async () => (await h.notif.query(sql, params as unknown[])).rows,
      cancel: async () => undefined,
    }),
  };
  return { ...actual, notifDbWrite: () => pool, notifDbRead: () => pool };
});

import { UNSEEN_COUNT_LIMIT } from '@civitai/notifications';
import { queryUnseenNotifications } from './operations';

const ddlDir = fileURLToPath(
  new URL('../../../../../containers/notification-db/docker-init/', import.meta.url)
);

const SINCE = new Date('2026-11-01T00:00:00.000Z');
// [userId, notification id, type, createdAt (UTC), viewed]
const ROWS: Array<[number, number, string, string, boolean]> = [
  // User 7: three unseen in the window, one seen, one before the window, one emailed type.
  [7, 1, 'new-comment', '2026-11-05T10:00:00.000000', false],
  [7, 2, 'new-mention', '2026-11-04T10:00:00.000000', false],
  [7, 3, 'new-reaction', '2026-11-03T10:00:00.000000', false],
  [7, 4, 'new-comment', '2026-11-06T10:00:00.000000', true],
  [7, 5, 'new-comment', '2026-10-30T10:00:00.000000', false],
  [7, 6, 'app-block-rejected', '2026-11-06T11:00:00.000000', false],
  // User 8: everything seen.
  [8, 7, 'new-comment', '2026-11-05T10:00:00.000000', true],
  // User 9: one unseen, but before user 9's own (later) window start.
  [9, 8, 'new-comment', '2026-11-02T10:00:00.000000', false],
  [9, 9, 'new-comment', '2026-11-05T10:00:00.000000', false],
  // User 12: around a start floor of 2026-11-10T09:00:00.000Z, a millisecond either side and on it.
  [12, 20, 'new-comment', '2026-11-10T08:59:59.999000', false],
  [12, 21, 'new-comment', '2026-11-10T09:00:00.000000', false],
  [12, 22, 'new-comment', '2026-11-10T09:00:00.001000', false],
];

beforeAll(async () => {
  h.notif = new PGlite();
  await h.notif.exec(
    readFileSync(ddlDir + '01_all_ddl.sql', 'utf8').replaceAll('CONCURRENTLY', '')
  );
  for (const [userId, n, type, createdAt, viewed] of ROWS) {
    await h.notif.query(
      `INSERT INTO "Notification" (id, type, key, category, details) VALUES ($1, $2, $3, 'Comment', $4)`,
      [n, type, `k${n}`, JSON.stringify({ n })]
    );
    await h.notif.query(
      `INSERT INTO "UserNotification" (id, "notificationId", "userId", "createdAt", viewed) VALUES ($1, $2, $3, $4, $5)`,
      [3_000_000_000 + n, n, userId, createdAt, viewed]
    );
  }
});

const ids = (items: { details: Record<string, unknown> }[]) => items.map((i) => i.details.n);

describe('unseen notifications for the digest', () => {
  it('lists the unseen rows in the window newest first, counts them all, and leaves out users with none', async () => {
    const result = await queryUnseenNotifications({
      users: [
        { userId: 7, since: SINCE },
        { userId: 8, since: SINCE },
      ],
      excludeTypes: [],
      limit: 2,
    });
    expect(result.map((u) => u.userId)).toEqual([7]);
    const [user] = result;
    expect(user!.total).toBe(4);
    expect(user!.floor).toBe(false);
    expect(ids(user!.items)).toEqual([6, 1]);
    expect(user!.items[0]!.type).toBe('app-block-rejected');
    expect(user!.items[0]!.id).toBe(3_000_000_006);
  });

  it('leaves the excluded types out of both the list and the count', async () => {
    const [user] = await queryUnseenNotifications({
      users: [{ userId: 7, since: SINCE }],
      excludeTypes: ['app-block-rejected'],
      limit: 10,
    });
    expect(user!.total).toBe(3);
    expect(ids(user!.items)).toEqual([1, 2, 3]);
  });

  it("applies each user's own window start", async () => {
    const result = await queryUnseenNotifications({
      users: [{ userId: 9, since: new Date('2026-11-03T00:00:00.000Z') }],
      excludeTypes: [],
      limit: 10,
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.total).toBe(1);
    expect(ids(result[0]!.items)).toEqual([9]);
  });

  // The digest passes a user's start floor as `since`: what was created before it, or at it (the
  // moment the floor was recorded, already covered), is never listed or counted.
  it('lists only what was created strictly after `since`', async () => {
    const [user] = await queryUnseenNotifications({
      users: [{ userId: 12, since: new Date('2026-11-10T09:00:00.000Z') }],
      excludeTypes: [],
      limit: 10,
    });
    expect(user!.total).toBe(1);
    expect(ids(user!.items)).toEqual([22]);
  });

  it('stops counting at the ceiling and says so', async () => {
    await h.notif.exec(`
      INSERT INTO "Notification" (id, type, key, category, details)
        SELECT 100000 + g, 'new-follower', 'bulk' || g, 'Other', '{}' FROM generate_series(1, ${
          UNSEEN_COUNT_LIMIT + 5
        }) g;
      INSERT INTO "UserNotification" (id, "notificationId", "userId", "createdAt", viewed)
        SELECT 4000000000 + g, 100000 + g, 11, '2026-11-05T00:00:00', false FROM generate_series(1, ${
          UNSEEN_COUNT_LIMIT + 5
        }) g;
    `);
    const [user] = await queryUnseenNotifications({
      users: [{ userId: 11, since: SINCE }],
      excludeTypes: [],
      limit: 3,
    });
    expect(user!.total).toBe(UNSEEN_COUNT_LIMIT);
    expect(user!.floor).toBe(true);
    expect(user!.items).toHaveLength(3);
  });
});
