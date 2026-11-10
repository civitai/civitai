import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const h = vi.hoisted(() => ({ notif: undefined as unknown as PGlite }));

vi.mock('./clients/db', () => {
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      const res = await h.notif.query(sql, params as unknown[]);
      return { rows: res.rows, rowCount: res.affectedRows ?? 0 };
    },
    cancellableQuery: async (sql: string, params?: unknown[]) => ({
      result: async () => (await h.notif.query(sql, params as unknown[])).rows,
    }),
  };
  return { notifDbWrite: () => pool, notifDbRead: () => pool };
});
vi.mock('./lag', async () => ({
  getNotifDbWithoutLag: async () => (await import('./clients/db')).notifDbRead(),
  isWritePool: () => true,
  preventReplicationLag: vi.fn(async () => undefined),
}));
vi.mock('./cache', () => ({
  notificationCache: { decrementUser: vi.fn(async () => undefined) },
}));
vi.mock('./clients/axiom', () => ({ logToAxiom: vi.fn(async () => undefined), safeError: String }));

import { markNotificationsRead, userWriteQueues } from './operations';
import { notificationCache } from './cache';

const ddl = fileURLToPath(
  new URL('../../../../../containers/notification-db/docker-init/01_all_ddl.sql', import.meta.url)
);

const CALLER = 4;
const OTHER = 5;
const CALLERS_ROW = 101;
const OTHERS_ROW = 102;

async function markRead(userId: number, id: number) {
  markNotificationsRead({ userId, id });
  await userWriteQueues.get(userId);
}

async function isViewed(id: number) {
  const { rows } = await h.notif.query<{ viewed: boolean }>(
    `SELECT viewed FROM "UserNotification" WHERE id = $1`,
    [id]
  );
  return rows[0].viewed;
}

beforeEach(async () => {
  vi.clearAllMocks();
  h.notif = new PGlite();
  await h.notif.exec(readFileSync(ddl, 'utf8').replaceAll('CONCURRENTLY', ''));
  await h.notif.query(
    `INSERT INTO "Notification" (id, type, key, category, details) VALUES (1, 't', 'k1', 'Comment', '{}')`
  );
  await h.notif.query(
    `INSERT INTO "UserNotification" (id, "notificationId", "userId") VALUES ($1, 1, $2), ($3, 1, $4)`,
    [CALLERS_ROW, CALLER, OTHERS_ROW, OTHER]
  );
});

describe('mark one notification read by id', () => {
  it("leaves another user's notification unread and their count alone", async () => {
    await markRead(CALLER, OTHERS_ROW);

    expect(await isViewed(OTHERS_ROW)).toBe(false);
    expect(notificationCache.decrementUser).not.toHaveBeenCalled();
  });

  it("marks the caller's own notification read", async () => {
    await markRead(CALLER, CALLERS_ROW);

    expect(await isViewed(CALLERS_ROW)).toBe(true);
    expect(notificationCache.decrementUser).toHaveBeenCalledWith(CALLER, 'Comment');
  });
});
