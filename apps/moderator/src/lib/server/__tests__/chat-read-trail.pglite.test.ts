import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import type { Reader } from '../chat-read-audit';

/**
 * Every Chat Audit surface that shows message text records that the moderator read it. A surface added
 * or reworked without the write is a read nobody can see later, so each one is pinned here against the
 * rows it actually inserts.
 */

const { dbHandle, insert } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  insert: vi.fn(async (_args: { values: Record<string, unknown>[] }) => undefined),
}));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../clickhouse', () => ({ getClickhouse: () => ({ insert }) }));

const { searchChats, getUserMessages, getUserMessagesById } = await import('../chat-audit.service');
const { getNewestMessages, getSpamGroups } = await import('../chat-insights.service');
const { recordChatMessageReads } = await import('../chat-read-audit');

const READER = 99 as Reader;
let db: PGlite;

beforeEach(async () => {
  insert.mockClear();
  db = await freshPglite();
  await db.exec(`
    CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT, "bannedAt" TIMESTAMP,
      "muted" BOOLEAN, "deletedAt" TIMESTAMP, "isModerator" BOOLEAN);
    CREATE TABLE "ChatMember" ("chatId" INTEGER, "userId" INTEGER, "isOwner" BOOLEAN);
    CREATE TABLE "ChatMessage" ("id" INTEGER PRIMARY KEY, "chatId" INTEGER NOT NULL,
      "userId" INTEGER NOT NULL, "content" TEXT NOT NULL, "editedAt" TIMESTAMP, "deletedAt" TIMESTAMP,
      "createdAt" TIMESTAMP NOT NULL DEFAULT now());
    INSERT INTO "User" ("id","username") VALUES (-1,'system'), (10,'spammer'), (11,'other');
    INSERT INTO "ChatMember" VALUES (1,10,true), (1,11,false), (2,10,true), (2,11,false);
    INSERT INTO "ChatMessage" ("id","chatId","userId","content") VALUES
      (1, 1, 10, 'join discord.gg/x'), (2, 1, 11, 'no thanks'),
      (3, 2, 10, 'join discord.gg/x'), (4, 2, 11, 'who is this'), (5, 1, 11, 'blocked');
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const reads = () =>
  insert.mock.calls
    .flatMap(([{ values }]) => values)
    .map((v) => ({ type: v.type, actorId: v.actorId, chatId: v.chatId, subjectId: v.subjectId }))
    .sort(
      (a, b) => Number(a.chatId) - Number(b.chatId) || Number(a.subjectId) - Number(b.subjectId)
    );
const read = (chatId: number, subjectId: number) => ({
  type: 'read',
  actorId: READER,
  chatId,
  subjectId,
});

describe('read trail', () => {
  it('records each chat whose excerpt a content search showed', async () => {
    await searchChats(READER, 'discord.gg');
    expect(reads()).toEqual([read(1, 10), read(2, 10)]);
  });

  it("records each chat an account's messages came from, looked up by id or by name", async () => {
    await getUserMessagesById(READER, 11);
    expect(reads()).toEqual([read(1, 11), read(2, 11)]);

    insert.mockClear();
    await getUserMessages(READER, 'spammer');
    expect(reads()).toEqual([read(1, 10), read(2, 10)]);
  });

  it('records each chat and sender in the newest feed', async () => {
    await getNewestMessages(READER);
    expect(reads()).toEqual([read(1, 10), read(1, 11), read(2, 10), read(2, 11)]);
  });

  it('records a spam group as a read of its sender, not of any one chat', async () => {
    await getSpamGroups(READER);
    expect(reads()).toEqual([read(0, 10)]);
  });

  it('records messages loaded by id as reads of their chats', async () => {
    await recordChatMessageReads(READER, [1, 4]);
    expect(reads()).toEqual([read(1, 10), read(2, 11)]);
  });

  it('lets a read go ahead when the message lookup for its trail fails', async () => {
    await db.exec(`DROP TABLE "ChatMessage"`);
    await expect(recordChatMessageReads(READER, [1])).resolves.toBeUndefined();
    expect(insert).not.toHaveBeenCalled();
  });

  it('records nothing for a search that showed nothing', async () => {
    await searchChats(READER, 'nothing like this anywhere');
    expect(insert).not.toHaveBeenCalled();
  });
});
