import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../clickhouse', () => ({ getClickhouse: () => ({}) }));

const { getChatWindow, getJudgedMessages } = await import('../chat-audit.service');

let db: PGlite;

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(`
    CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT, "bannedAt" TIMESTAMP);
    CREATE TABLE "ChatMessage" ("id" INTEGER PRIMARY KEY, "chatId" INTEGER NOT NULL,
      "userId" INTEGER NOT NULL, "content" TEXT NOT NULL, "editedAt" TIMESTAMP, "deletedAt" TIMESTAMP,
      "createdAt" TIMESTAMP NOT NULL DEFAULT now());
    INSERT INTO "User" ("id","username") VALUES (-1,'system'), (10,'sender'), (11,'other');
    -- chat 1: ids 101..130 alternate between the two members; 5 other chats' rows sit between them.
    INSERT INTO "ChatMessage" ("id","chatId","userId","content")
      SELECT g, 1, CASE WHEN g % 2 = 0 THEN 10 ELSE 11 END, 'm' || g FROM generate_series(101, 130) g;
    INSERT INTO "ChatMessage" ("id","chatId","userId","content")
      SELECT g, 2, 11, 'elsewhere' FROM generate_series(131, 135) g;
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const ids = (window: { rows: { id: number }[] }) => window.rows.map((r) => r.id);

describe('getChatWindow', () => {
  it('returns the held span plus the requested messages on each side, oldest first', async () => {
    const window = await getChatWindow(1, [112, 116, 120], 3, 2);
    const { rows } = window;
    expect(ids(window)).toEqual([
      109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122,
    ]);
    expect(rows.find((r) => r.id === 112)).toMatchObject({ username: 'sender', content: 'm112' });
  });

  it('stops at the start and the end of the chat', async () => {
    expect(ids(await getChatWindow(1, [102], 10, 1))).toEqual([101, 102, 103]);
    expect(ids(await getChatWindow(1, [129], 1, 10))).toEqual([128, 129, 130]);
  });

  it('keeps other chats out', async () => {
    expect(ids(await getChatWindow(1, [130], 0, 10))).toEqual([130]);
    expect(ids(await getChatWindow(2, [131], 0, 10))).toEqual([131, 132, 133, 134, 135]);
  });

  it('leaves system messages out and keeps deleted ones', async () => {
    await db.exec(`
      UPDATE "ChatMessage" SET "userId" = -1 WHERE id = 111;
      UPDATE "ChatMessage" SET "deletedAt" = now() WHERE id = 113;
    `);
    const window = await getChatWindow(1, [110, 114], 0, 0);
    expect(ids(window)).toEqual([110, 112, 113, 114]);
    expect(window.rows.find((r) => r.id === 113)?.deletedAt).toBeInstanceOf(Date);
  });

  it('reads nothing for a bad chat id or no ids', async () => {
    const none = { rows: [], omitted: 0 };
    expect(await getChatWindow(0, [110])).toEqual(none);
    expect(await getChatWindow(1, [])).toEqual(none);
    expect(await getChatWindow(3, [110], 5, 5)).toEqual(none);
  });

  it('does not anchor on ids that are not in the chat', async () => {
    // 131 is in chat 2 and 9999 is nowhere: neither may stretch the span or shift the context.
    const window = await getChatWindow(1, [112, 131, 9999], 1, 1);
    expect(ids(window)).toEqual([111, 112, 113]);
    expect(window.omitted).toBe(0);
    expect(await getChatWindow(1, [131, 9999])).toEqual({ rows: [], omitted: 0 });
  });

  describe('a span longer than the cap', () => {
    beforeEach(async () => {
      await db.exec(`
        INSERT INTO "ChatMessage" ("id","chatId","userId","content")
          SELECT g, 3, 11, 'long' || g FROM generate_series(1000, 1299) g;
      `);
    });

    it('keeps the newest of the span, reads the earlier context from where it starts, and counts the rest', async () => {
      const window = await getChatWindow(3, [1000, 1299], 3, 2);
      const shown = ids(window);
      expect(shown).toEqual(Array.from({ length: 203 }, (_, i) => 1097 + i));
      // Contiguous: no message between neighbours is missing; the 97 before 1097 are the ones not shown.
      expect(window.omitted).toBe(97);
    });

    it('reports nothing omitted when the context covers the cap overflow', async () => {
      // 201 messages between the judged ones: only 1 falls off the span, and 3 are read back before it.
      const window = await getChatWindow(3, [1000, 1200], 3, 0);
      expect(ids(window)[0]).toBe(1000);
      expect(window.omitted).toBe(0);
    });
  });
});

describe('getJudgedMessages', () => {
  it("returns only the sender's judged messages, never another member's", async () => {
    // 104 and 106 are the sender's; 105 is the other member's, asked for as if it were judged.
    const rows = await getJudgedMessages(1, [104, 105, 106], 10);
    expect(rows.map((r) => r.id)).toEqual([104, 106]);
  });

  it('ignores ids from another chat and returns nothing without a sender', async () => {
    expect(await getJudgedMessages(1, [132], 11)).toEqual([]);
    expect(await getJudgedMessages(1, [104], null)).toEqual([]);
  });
});
