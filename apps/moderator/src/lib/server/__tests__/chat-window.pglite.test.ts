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

const { getChatWindow } = await import('../chat-audit.service');

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

const ids = (rows: { id: number }[]) => rows.map((r) => r.id);

describe('getChatWindow', () => {
  it('returns the held span plus the requested messages on each side, oldest first', async () => {
    const rows = await getChatWindow(1, [112, 116, 120], 3, 2);
    expect(ids(rows)).toEqual([
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
    const rows = await getChatWindow(1, [110, 114], 0, 0);
    expect(ids(rows)).toEqual([110, 112, 113, 114]);
    expect(rows.find((r) => r.id === 113)?.deletedAt).toBeInstanceOf(Date);
  });

  it('reads nothing for a bad chat id or no ids', async () => {
    expect(await getChatWindow(0, [110])).toEqual([]);
    expect(await getChatWindow(1, [])).toEqual([]);
    expect(await getChatWindow(3, [110], 5, 5)).toEqual([]);
  });
});
