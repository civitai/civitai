import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { commentNotifications, threadUrlMap } from '~/server/notifications/comment.notifications';

/** Runs the real `new-storyline-comment` query against an in-process Postgres. */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const OWNER = 1;
const READER = 2;
const LAST_SENT = '2026-10-23T10:00:00.000Z';
const AFTER = '2026-10-23 10:00:05';

const processor = commentNotifications['new-storyline-comment'];
let db: PGlite;

const run = async () =>
  (
    await db.query<{ userId: number; type: string; details: Record<string, unknown> }>(
      (processor.prepareQuery as (a: { lastSent: string }) => string)({ lastSent: LAST_SENT })
    )
  ).rows;

beforeAll(async () => {
  db = new PGlite({ extensions: { ltree } });
  await db.exec(`
    CREATE EXTENSION ltree;
    CREATE TABLE "User"(id int PRIMARY KEY, username text);
    CREATE TABLE "UserEngagement"("userId" int, "targetUserId" int, type text);
    CREATE TABLE "UserNotificationSettings"("userId" int, type text);
    CREATE TABLE "Storyline"(id int PRIMARY KEY, "userId" int, title text, "tosViolation" boolean NOT NULL DEFAULT false);
    CREATE TABLE "CommentV3"(id int PRIMARY KEY, "entityType" text, "entityId" int, "parentId" int,
      "replyToId" int, path ltree, "userId" int, "createdAt" timestamp(3), "deletedAt" timestamp(3));
    CREATE TABLE "CommentMute"("userId" int, "commentId" int);
    CREATE TABLE "CommentTopicMute"("userId" int, "entityType" text, "entityId" int);
    INSERT INTO "User" VALUES (1, 'owner'), (2, 'reader');
  `);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(`
    TRUNCATE "UserEngagement", "UserNotificationSettings", "Storyline", "CommentV3", "CommentMute", "CommentTopicMute";
    INSERT INTO "Storyline" VALUES (10, ${OWNER}, 'Night Train', false);
  `);
});

const comment = (id: number, userId: number, createdAt = AFTER, parentId: number | null = null) =>
  db.exec(
    `INSERT INTO "CommentV3" VALUES (${id}, 'storyline', 10, ${parentId}, NULL,
      '${parentId ? `${parentId}.${id}` : id}', ${userId}, '${createdAt}', NULL)`
  );

describe('new-storyline-comment', () => {
  it("tells the owner about a reader's comment, linked to the comment on the storyline page", async () => {
    await comment(500, READER);
    const rows = await run();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: OWNER, type: 'new-storyline-comment' });
    expect(
      processor.prepareMessage({ type: 'new-storyline-comment', details: rows[0].details } as never)
    ).toEqual({
      message: 'reader commented on your storyline: "Night Train"',
      url: '/storylines/10?highlight=500',
    });
  });

  it.each([
    ['the owner wrote it', () => comment(500, OWNER)],
    ['it predates the last run', () => comment(500, READER, '2026-10-23 09:59:00')],
    [
      'the storyline is taken down',
      async () => {
        await db.exec(`UPDATE "Storyline" SET "tosViolation" = true`);
        await comment(500, READER);
      },
    ],
    [
      'the owner blocked the commenter',
      async () => {
        await db.exec(`INSERT INTO "UserEngagement" VALUES (${OWNER}, ${READER}, 'Block')`);
        await comment(500, READER);
      },
    ],
    [
      'the owner muted the storyline discussion',
      async () => {
        await db.exec(`INSERT INTO "CommentTopicMute" VALUES (${OWNER}, 'storyline', 10)`);
        await comment(500, READER);
      },
    ],
    [
      'it is a reply, which the reply notifications cover',
      async () => {
        await comment(500, OWNER);
        await comment(501, READER, AFTER, 500);
      },
    ],
    [
      'the comment is deleted',
      async () => {
        await comment(500, READER);
        await db.exec(`UPDATE "CommentV3" SET "deletedAt" = now() WHERE id = 500`);
      },
    ],
    [
      'the owner turned the type off',
      async () => {
        await db.exec(
          `INSERT INTO "UserNotificationSettings" VALUES (${OWNER}, 'new-storyline-comment')`
        );
        await comment(500, READER);
      },
    ],
  ])('is not sent when %s', async (_label, arrange) => {
    await arrange();
    expect(await run()).toEqual([]);
  });

  it('links a reply in a storyline thread to the storyline page', () => {
    expect(
      threadUrlMap({ threadType: 'storyline', threadParentId: 10, commentId: 5, threadId: 9 })
    ).toMatch(/^\/storylines\/10\?/);
  });
});
