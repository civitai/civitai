import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EnvModule from '../env';

/**
 * A debounced notification is re-surfaced by upserting each recipient's row. The worker bumps the
 * unread badge counter per returned recipient, so it must know which recipients already had the row
 * unread (already counted) — read off the real upsert, not a canned response.
 */

vi.mock('../lib/server/clients/db', () => ({
  notifDbWrite: () => ({}),
  notifDbRead: () => ({}),
  mainDbRead: () => ({}),
}));
vi.mock('../lib/server/clients/axiom', () => ({
  logToAxiom: vi.fn(async () => undefined),
  logAxiomError: vi.fn(),
  safeError: (e: unknown) => ({ message: String(e) }),
}));
vi.mock('../env', async (importOriginal) => ({
  ...(await importOriginal<typeof EnvModule>()),
  pushEnabled: false,
}));

const { handleDebounce } = await import('./poll-loop');

const NOTIFICATION = 42;
const UNREAD = 11;
const READ = 22;
const NEW = 33;

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Notification" (
      id serial PRIMARY KEY, type text NOT NULL, key text NOT NULL UNIQUE, category text, details jsonb
    );
    CREATE TABLE "PendingNotification" (
      id serial PRIMARY KEY, "claimedAt" timestamp, "nextSendAt" timestamp, "debounceSeconds" int
    );
    CREATE TABLE "UserNotification" (
      id bigserial PRIMARY KEY, "notificationId" int NOT NULL REFERENCES "Notification"(id),
      "userId" int NOT NULL, viewed boolean NOT NULL DEFAULT false,
      "createdAt" timestamp(6) NOT NULL DEFAULT now(),
      UNIQUE ("notificationId", "userId")
    );
  `);
});
afterAll(() => db.close());
beforeEach(async () => {
  await db.exec(`
    TRUNCATE "UserNotification", "Notification", "PendingNotification" RESTART IDENTITY CASCADE;
    INSERT INTO "Notification" (id, type, key, category, details)
      VALUES (${NOTIFICATION}, 'collection-update', 'collection:1', 'Update', '{}');
    INSERT INTO "PendingNotification" (id, "debounceSeconds") VALUES (7, 60);
    INSERT INTO "UserNotification" ("notificationId", "userId", viewed)
      VALUES (${NOTIFICATION}, ${UNREAD}, false), (${NOTIFICATION}, ${READ}, true);
  `);
});

const row = {
  id: 7,
  type: 'collection-update',
  category: 'Update',
  key: 'collection:1',
  details: { collectionId: 1 },
  users: [UNREAD, READ, NEW],
  debounceSeconds: 60,
  // Window elapsed: fan out.
  lastTriggered: '2026-01-01T00:05:00.000Z',
  nextSendAt: '2026-01-01T00:05:30.000Z',
};

describe('handleDebounce re-surface', () => {
  it('flags only the recipient who still had the notification unread', async () => {
    const ret = await handleDebounce(row as never, db as never);

    const byUser = Object.fromEntries(ret.map((r) => [r.userId, r.wasUnread]));
    expect(byUser).toEqual({ [UNREAD]: true, [READ]: false, [NEW]: false });
  });

  it('reads only this notification’s row for each recipient, not their other notifications', async () => {
    await db.exec(`
      INSERT INTO "Notification" (id, type, key, category) VALUES (43, 'comment', 'comment:1', 'Comment');
      INSERT INTO "UserNotification" ("notificationId", "userId", viewed) VALUES (43, ${READ}, false);
    `);

    const ret = await handleDebounce(row as never, db as never);

    expect(ret).toHaveLength(3);
    expect(ret.find((r) => r.userId === READ)?.wasUnread).toBe(false);
  });

  it('still re-surfaces every recipient as unread', async () => {
    await handleDebounce(row as never, db as never);

    const { rows } = await db.query<{ userId: number; viewed: boolean }>(
      `SELECT "userId", viewed FROM "UserNotification" ORDER BY "userId"`
    );
    expect(rows).toEqual([
      { userId: UNREAD, viewed: false },
      { userId: READ, viewed: false },
      { userId: NEW, viewed: false },
    ]);
  });
});
