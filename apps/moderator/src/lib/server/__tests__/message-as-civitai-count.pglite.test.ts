import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';

// The sidebar badge: Civitai Moderation threads whose last real message is the user's.
const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));
vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));

const { countAwaitingReply } = await import('../message-as-civitai-count');

const CIVITAI = 900;
let db: PGlite;

beforeEach(async () => {
  process.env.CIVITAI_MODERATION_USER_ID = String(CIVITAI);
  db = await freshPglite();
  await db.exec(`
    CREATE TABLE "Chat" ("id" INTEGER PRIMARY KEY, "isGroup" BOOLEAN NOT NULL DEFAULT false);
    INSERT INTO "Chat" ("id","isGroup") VALUES (1,false),(2,false),(3,false),(4,false),(5,true);
    CREATE TABLE "ChatMember" ("chatId" INTEGER NOT NULL, "userId" INTEGER NOT NULL);
    CREATE TABLE "ChatMessage" ("id" INTEGER PRIMARY KEY, "chatId" INTEGER NOT NULL,
      "userId" INTEGER NOT NULL, "deletedAt" TIMESTAMP);
    INSERT INTO "ChatMember" VALUES (1, ${CIVITAI}), (1, 501), (2, ${CIVITAI}), (2, 502),
      (3, ${CIVITAI}), (3, 503), (4, 10), (4, 11), (5, ${CIVITAI}), (5, 504), (5, 505);
    -- 1: the user answered. 2: Civitai spoke last. 3: the user's reply was deleted, then a system line.
    -- 4: an ordinary chat between two other people. 5: a group the account is in, where a user spoke last.
    INSERT INTO "ChatMessage" ("id","chatId","userId","deletedAt") VALUES
      (1, 1, ${CIVITAI}, NULL), (2, 1, 501, NULL),
      (3, 2, 502, NULL), (4, 2, ${CIVITAI}, NULL),
      (5, 3, ${CIVITAI}, NULL), (6, 3, 503, now()), (7, 3, -1, NULL),
      (8, 4, 10, NULL), (9, 4, 11, NULL), (10, 5, 504, NULL);
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  delete process.env.CIVITAI_MODERATION_USER_ID;
  dbHandle.current = null;
  await db.close();
});

describe('countAwaitingReply', () => {
  it('counts only 1:1 threads where the user spoke last, ignoring deleted and system messages', async () => {
    expect(await countAwaitingReply()).toBe(1);
  });

  it('is 0 when the account is not configured', async () => {
    delete process.env.CIVITAI_MODERATION_USER_ID;
    expect(await countAwaitingReply()).toBe(0);
  });
});
