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
vi.mock('./lag', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getNotifDbWithoutLag: async () => (await import('./clients/db')).notifDbRead(),
}));

import {
  pageNotifications,
  parseNotificationCursor,
  type NotificationListCursor,
} from '@civitai/notifications';
import { queryNotifications } from './operations';

const ddlDir = fileURLToPath(
  new URL('../../../../../containers/notification-db/docker-init/', import.meta.url)
);

const USER = 5;
// Seven rows in list order (newest first, then id descending). Three share one timestamp so a page
// boundary can fall inside the tie.
const SEED: Array<[id: number, createdAt: string]> = [
  [1, '2026-11-04T05:00:00.000Z'],
  [4, '2026-11-04T04:00:00.000Z'],
  [3, '2026-11-04T04:00:00.000Z'],
  [2, '2026-11-04T04:00:00.000Z'],
  [5, '2026-11-04T03:00:00.000Z'],
  [6, '2026-11-04T02:00:00.000Z'],
  [7, '2026-11-04T01:00:00.000Z'],
];

// [id, createdAt, category, viewed]: the unread Comment rows are 11, 13, 14, 16, 18, two of them tied.
const MIXED_USER = 6;
const MIXED: Array<[number, string, 'Comment' | 'Buzz', boolean]> = [
  [11, '2026-11-04T05:00:00.000Z', 'Comment', false],
  [12, '2026-11-04T04:30:00.000Z', 'Buzz', false],
  [14, '2026-11-04T04:00:00.000Z', 'Comment', false],
  [13, '2026-11-04T04:00:00.000Z', 'Comment', false],
  [15, '2026-11-04T04:00:00.000Z', 'Comment', true],
  [16, '2026-11-04T03:00:00.000Z', 'Comment', false],
  [17, '2026-11-04T02:00:00.000Z', 'Buzz', false],
  [18, '2026-11-04T01:00:00.000Z', 'Comment', false],
];

beforeAll(async () => {
  h.notif = new PGlite();
  await h.notif.exec(
    readFileSync(ddlDir + '01_all_ddl.sql', 'utf8').replaceAll('CONCURRENTLY', '')
  );
  for (const [id, createdAt] of SEED) {
    await h.notif.query(
      `INSERT INTO "Notification" (id, type, key, category, details) VALUES ($1, 'new-comment', $2, 'Comment', '{}')`,
      [id, `k${id}`]
    );
    await h.notif.query(
      `INSERT INTO "UserNotification" (id, "notificationId", "userId", "createdAt") VALUES ($1, $1, $2, $3)`,
      [id, USER, createdAt.replace('Z', '')]
    );
  }
  for (const [id, createdAt, category, viewed] of MIXED) {
    await h.notif.query(
      `INSERT INTO "Notification" (id, type, key, category, details) VALUES ($1, 't', $2, $3, '{}')`,
      [id, `k${id}`, category]
    );
    await h.notif.query(
      `INSERT INTO "UserNotification" (id, "notificationId", "userId", "createdAt", viewed) VALUES ($1, $1, $2, $3, $4)`,
      [id, MIXED_USER, createdAt.replace('Z', ''), viewed]
    );
  }
});

async function pageThrough(
  limit: number,
  filter: { userId: number; category?: 'Comment'; unread?: boolean } = { userId: USER }
) {
  const seen: number[] = [];
  let cursor: NotificationListCursor | undefined;
  for (let guard = 0; guard < 20; guard++) {
    const rows = await queryNotifications({ ...filter, limit: limit + 1, cursor });
    const page = pageNotifications(rows, limit);
    seen.push(...page.items.map((r) => r.id));
    if (!page.nextCursor) break;
    cursor = parseNotificationCursor(page.nextCursor);
  }
  return seen;
}

describe('paging the notification list', () => {
  it.each([1, 2, 3, 4, 7, 8])('shows every row exactly once at page size %i', async (limit) => {
    expect(await pageThrough(limit)).toEqual(SEED.map(([id]) => id));
  });

  it.each([1, 2, 3])(
    'with category and unread-only set, shows every matching row once at page size %i',
    async (limit) => {
      const seen = await pageThrough(limit, {
        userId: MIXED_USER,
        category: 'Comment',
        unread: true,
      });

      expect(seen).toEqual([11, 14, 13, 16, 18]);
    }
  );

  it('a legacy date cursor reads strictly before that date, as it did', async () => {
    const rows = await queryNotifications({
      userId: USER,
      limit: 3,
      cursor: new Date('2026-11-04T04:00:00.000Z'),
    });

    expect(rows.map((r) => r.id)).toEqual([5, 6, 7]);
  });

  it('a caller still paging with legacy date cursors always reaches the end', async () => {
    // A page of 2 ends inside the three-row tie, the case a non-strict bound never leaves.
    const pageSize = 2;
    let pages = 0;
    let cursor: Date | undefined;
    for (; pages < 20; pages++) {
      const rows = await queryNotifications({ userId: USER, limit: pageSize + 1, cursor });
      if (rows.length <= pageSize) break;
      cursor = rows.pop()?.createdAt;
    }

    expect(pages).toBeLessThanOrEqual(Math.ceil(SEED.length / pageSize));
  });
});
