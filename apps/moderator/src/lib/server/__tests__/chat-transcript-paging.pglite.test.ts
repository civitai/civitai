import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import type { Reader } from '../chat-read-audit';

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../clickhouse', () => ({ getClickhouse: () => ({ insert: async () => undefined }) }));

const { getTranscript, getUserMessages } = await import('../chat-audit.service');

const READER = 99 as Reader;
let db: PGlite;

beforeEach(async () => {
  db = await freshPglite();
  // Chat 1 holds messages 1-7 from two members; 4 and 5 share a timestamp, so only the id orders them.
  await db.exec(`
    CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT, "bannedAt" TIMESTAMP,
      "deletedAt" TIMESTAMP);
    CREATE TABLE "ModActivity" ("id" INTEGER, "userId" INTEGER, "entityType" TEXT, "activity" TEXT,
      "entityId" INTEGER);
    CREATE TABLE "ChatMessage" ("id" INTEGER PRIMARY KEY, "chatId" INTEGER NOT NULL,
      "userId" INTEGER NOT NULL, "content" TEXT NOT NULL, "editedAt" TIMESTAMP, "deletedAt" TIMESTAMP,
      "createdAt" TIMESTAMP NOT NULL);
    INSERT INTO "User" ("id","username") VALUES (-1,'system'), (10,'alice'), (11,'bob');
    INSERT INTO "ChatMessage" ("id","chatId","userId","content","createdAt") VALUES
      (1, 1, 10, 'm1', '2026-11-01 00:01'), (2, 1, 11, 'm2', '2026-11-01 00:02'),
      (3, 1, 10, 'm3', '2026-11-01 00:03'), (4, 1, 11, 'm4', '2026-11-01 00:04'),
      (5, 1, 10, 'm5', '2026-11-01 00:04'), (6, 1, 11, 'm6', '2026-11-01 00:06'),
      (7, 1, 10, 'm7', '2026-11-01 00:07'), (8, 2, 10, 'other chat', '2026-11-01 00:08');
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const ids = (t: { rows: { id: number }[] }) => t.rows.map((r) => r.id);

describe('a transcript longer than one page', () => {
  it('opens on the newest page, in reading order, saying older messages exist', async () => {
    const t = await getTranscript(READER, 1, {}, 3);
    expect(ids(t)).toEqual([5, 6, 7]);
    expect([t.hasOlder, t.hasNewer]).toEqual([true, false]);
  });

  it('walks back to the first message without skipping the ones that share a timestamp', async () => {
    const seen: number[] = [];
    let t = await getTranscript(READER, 1, {}, 3);
    seen.unshift(...ids(t));
    for (let i = 0; t.hasOlder && i < 10; i++) {
      t = await getTranscript(READER, 1, { before: t.rows[0].id }, 3);
      seen.unshift(...ids(t));
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(t.hasNewer).toBe(true);
  });

  it('walks forward again from an older page back to the newest', async () => {
    let t = await getTranscript(READER, 1, { before: 3 }, 3);
    expect(ids(t)).toEqual([1, 2]);
    t = await getTranscript(READER, 1, { after: t.rows.at(-1)!.id }, 3);
    expect(ids(t)).toEqual([3, 4, 5]);
    expect([t.hasOlder, t.hasNewer]).toEqual([true, true]);
    t = await getTranscript(READER, 1, { after: t.rows.at(-1)!.id }, 3);
    expect(ids(t)).toEqual([6, 7]);
    expect(t.hasNewer).toBe(false);
  });

  it("opens the newest page for a cursor that is another chat's message", async () => {
    const t = await getTranscript(READER, 1, { before: 8 }, 3);
    expect(ids(t)).toEqual([5, 6, 7]);
    expect(t.hasNewer).toBe(false);
  });
});

describe("an account's messages across chats, a page at a time", () => {
  it('continues past the oldest message shown, and says when it has left the newest page', async () => {
    const first = await getUserMessages(READER, 'alice', undefined, 2);
    expect(first!.rows.map((r) => r.id)).toEqual([8, 7]);
    expect([first!.truncated, first!.hasNewer]).toEqual([true, false]);

    const next = await getUserMessages(READER, 'alice', 7, 2);
    expect(next!.rows.map((r) => r.id)).toEqual([5, 3]);
    expect([next!.truncated, next!.hasNewer]).toEqual([true, true]);
  });

  it("ignores a cursor that is someone else's message", async () => {
    const page = await getUserMessages(READER, 'alice', 6, 2);
    expect(page!.rows.map((r) => r.id)).toEqual([8, 7]);
    expect(page!.hasNewer).toBe(false);
  });
});
