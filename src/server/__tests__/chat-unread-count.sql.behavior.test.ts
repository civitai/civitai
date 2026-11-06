import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { markAllReadSql, unreadCountSql } from '~/server/utils/chat';

/**
 * The header chat badge counts unread messages in the inbox AND in pending
 * Requests (product decision).
 * Inside a Request, a message from someone the reader has a block with, from a
 * banned account, or in a chat the reader reported does not count.
 */
const ME = 1;
const SENDER = 2;
const BLOCKED = 3;
const BLOCKER = 4;
const BANNED = 5;

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp(3));
    CREATE TABLE "ChatMember" (
      id serial PRIMARY KEY, "chatId" int NOT NULL, "userId" int NOT NULL, status text NOT NULL,
      "notifyLevel" text NOT NULL DEFAULT 'All', "lastViewedMessageId" int,
      "filteredAt" timestamp(3), "clearedAt" timestamp(3)
    );
    CREATE TABLE "ChatMessage" (
      id serial PRIMARY KEY, "chatId" int NOT NULL, "userId" int NOT NULL,
      "createdAt" timestamp(3) NOT NULL DEFAULT now(), "deletedAt" timestamp(3)
    );
    CREATE TABLE "UserEngagement" ("userId" int, "targetUserId" int, type text);
    CREATE TABLE "Report" (
      id int PRIMARY KEY, "userId" int NOT NULL, "alsoReportedBy" int[] NOT NULL DEFAULT '{}'
    );
    CREATE TABLE "ChatReport" ("chatId" int, "reportId" int);
  `);
});
afterAll(() => db.close());
beforeEach(async () => {
  await db.exec(`
    TRUNCATE "User", "ChatMember", "ChatMessage", "UserEngagement", "Report", "ChatReport";
    INSERT INTO "User" (id, "bannedAt") VALUES (1, NULL), (2, NULL), (3, NULL), (4, NULL), (5, now());
  `);
});

/** A two-person chat holding one unread message from `from` to me. */
const chat = async (
  chatId: number,
  from: number,
  me: { status?: string; filtered?: boolean } = {}
) => {
  await db.query(
    `INSERT INTO "ChatMember" ("chatId", "userId", status, "filteredAt") VALUES
       ($1, $2, $3, $4), ($1, $5, 'Joined', NULL)`,
    [chatId, ME, me.status ?? 'Joined', me.filtered ? new Date() : null, from]
  );
  await db.query(`INSERT INTO "ChatMessage" ("chatId", "userId") VALUES ($1, $2)`, [chatId, from]);
};

const badge = async () => {
  let total = 0;
  for (const sql of unreadCountSql(ME)) {
    const rows = (await db.query<{ chatId: number; cnt: number }>(sql.text, sql.values)).rows;
    total += rows.reduce((sum, row) => sum + row.cnt, 0);
  }
  return total;
};

describe('the header chat badge', () => {
  it('counts a pending Request when the inbox has nothing unread', async () => {
    await chat(10, SENDER, { status: 'Invited', filtered: true });
    expect(await badge()).toBe(1);
  });

  it('counts a re-filtered Joined membership too', async () => {
    await chat(10, SENDER, { status: 'Joined', filtered: true });
    expect(await badge()).toBe(1);
  });

  it('counts inbox and Request unread together', async () => {
    await chat(10, SENDER, { status: 'Invited', filtered: true });
    await chat(11, SENDER);
    expect(await badge()).toBe(2);
  });

  it('stops counting a Request once it is opened, until something newer arrives', async () => {
    await chat(10, SENDER, { status: 'Invited', filtered: true });
    await db.exec(`
      UPDATE "ChatMember" SET "lastViewedMessageId" = (SELECT max(id) FROM "ChatMessage")
      WHERE "userId" = ${ME}
    `);
    expect(await badge()).toBe(0);

    await db.query(`INSERT INTO "ChatMessage" ("chatId", "userId") VALUES (10, $1)`, [SENDER]);
    expect(await badge()).toBe(1);
  });

  it('counts an unfiltered invitation, which the inbox shows', async () => {
    await chat(10, SENDER, { status: 'Invited' });
    expect(await badge()).toBe(1);
  });

  it('leaves out a declined or left conversation', async () => {
    await chat(10, SENDER, { status: 'Ignored', filtered: true });
    await chat(11, SENDER, { status: 'Left' });
    expect(await badge()).toBe(0);
  });

  it('leaves out a Request from someone I blocked', async () => {
    await chat(10, BLOCKED, { status: 'Invited', filtered: true });
    await db.query(
      `INSERT INTO "UserEngagement" ("userId", "targetUserId", type) VALUES ($1, $2, 'Block')`,
      [ME, BLOCKED]
    );
    expect(await badge()).toBe(0);
  });

  it('leaves out a Request from someone who blocked me', async () => {
    await chat(10, BLOCKER, { status: 'Invited', filtered: true });
    await db.query(
      `INSERT INTO "UserEngagement" ("userId", "targetUserId", type) VALUES ($1, $2, 'Block')`,
      [BLOCKER, ME]
    );
    expect(await badge()).toBe(0);
  });

  it('in a group Request, counts the other authors but not the one I blocked', async () => {
    await chat(10, SENDER, { status: 'Invited', filtered: true });
    await message(10, BLOCKED);
    await message(10, BLOCKED);
    await db.query(
      `INSERT INTO "UserEngagement" ("userId", "targetUserId", type) VALUES ($1, $2, 'Block')`,
      [ME, BLOCKED]
    );
    expect(await badge()).toBe(1);
  });

  it('still counts a Request from someone I only follow', async () => {
    await chat(10, SENDER, { status: 'Invited', filtered: true });
    await db.query(
      `INSERT INTO "UserEngagement" ("userId", "targetUserId", type) VALUES ($1, $2, 'Follow')`,
      [ME, SENDER]
    );
    expect(await badge()).toBe(1);
  });

  it('leaves out a Request from a banned account', async () => {
    await chat(10, BANNED, { status: 'Invited', filtered: true });
    expect(await badge()).toBe(0);
  });

  it('leaves out a Request I reported, but not one someone else reported', async () => {
    await chat(10, SENDER, { status: 'Invited', filtered: true });
    await chat(11, SENDER, { status: 'Invited', filtered: true });
    await db.exec(`
      INSERT INTO "Report" (id, "userId") VALUES (100, ${ME}), (101, ${SENDER});
      INSERT INTO "ChatReport" ("chatId", "reportId") VALUES (10, 100), (11, 101);
    `);
    expect(await badge()).toBe(1);
  });

  it('leaves out a Request I reported second, folded into an earlier report', async () => {
    await chat(10, SENDER, { status: 'Invited', filtered: true });
    await db.exec(`
      INSERT INTO "Report" (id, "userId", "alsoReportedBy") VALUES (100, ${BLOCKER}, '{${ME}}');
      INSERT INTO "ChatReport" ("chatId", "reportId") VALUES (10, 100);
    `);
    expect(await badge()).toBe(0);
  });

  it('keeps inbox semantics: a blocked author in an accepted chat still counts', async () => {
    // Unchanged on purpose; the exclusions are for Requests only.
    await chat(10, BLOCKED);
    await db.query(
      `INSERT INTO "UserEngagement" ("userId", "targetUserId", type) VALUES ($1, $2, 'Block')`,
      [ME, BLOCKED]
    );
    expect(await badge()).toBe(1);
  });
});

const message = (chatId: number, from: number, extra = '') =>
  db.query(
    `INSERT INTO "ChatMessage" ("chatId", "userId", "createdAt", "deletedAt") VALUES ($1, $2, ${
      extra || 'now(), NULL'
    })`,
    [chatId, from]
  );

describe.each([
  ['the inbox', false],
  ['a Request', true],
])('in %s, the badge leaves out', (_, filtered) => {
  const open = () => chat(10, SENDER, { status: 'Invited', filtered });

  it('my own messages', async () => {
    await open();
    await message(10, ME);
    expect(await badge()).toBe(1);
  });

  it('deleted messages', async () => {
    await open();
    await message(10, SENDER, `now(), now()`);
    expect(await badge()).toBe(1);
  });

  it('messages from before I cleared the conversation', async () => {
    await open();
    await db.exec(`UPDATE "ChatMember" SET "clearedAt" = now() WHERE "userId" = ${ME}`);
    await message(10, SENDER, `now() + interval '1 minute', NULL`);
    expect(await badge()).toBe(1);
  });

  it('a conversation I set to notify on nothing', async () => {
    await open();
    await db.exec(`UPDATE "ChatMember" SET "notifyLevel" = 'None' WHERE "userId" = ${ME}`);
    expect(await badge()).toBe(0);
  });
});

describe('system rows (user -1)', () => {
  it('count in the inbox, as they always have', async () => {
    await chat(10, SENDER);
    await message(10, -1);
    expect(await badge()).toBe(2);
  });

  it('do not count in a Request: a blocked sender’s link preview must not light the badge', async () => {
    // Decision: an embed or "added you" note is written as -1 on the sender's
    // behalf, so the block and ban checks cannot see who caused it.
    await chat(10, BLOCKED, { status: 'Invited', filtered: true });
    await message(10, -1);
    await db.query(
      `INSERT INTO "UserEngagement" ("userId", "targetUserId", type) VALUES ($1, $2, 'Block')`,
      [ME, BLOCKED]
    );
    expect(await badge()).toBe(0);
  });
});

describe('mark all as read', () => {
  it('clears every conversation the badge counts, Requests included', async () => {
    await chat(10, SENDER);
    await chat(11, SENDER, { status: 'Invited' });
    await chat(12, SENDER, { status: 'Invited', filtered: true });
    await chat(13, SENDER, { filtered: true });
    expect(await badge()).toBe(4);

    const sql = markAllReadSql(ME);
    await db.query(sql.text, sql.values);
    expect(await badge()).toBe(0);
  });
});

it('a Request stops counting at 99 unread', async () => {
  await chat(10, SENDER, { status: 'Invited', filtered: true });
  await db.exec(
    `INSERT INTO "ChatMessage" ("chatId", "userId") SELECT 10, ${SENDER} FROM generate_series(1, 120)`
  );
  expect(await badge()).toBe(99);
});
