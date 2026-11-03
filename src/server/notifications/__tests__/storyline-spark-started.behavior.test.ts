import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { storylineInviteNotifications } from '~/server/notifications/storyline.notifications';
import { notificationProcessors } from '~/server/notifications/utils.notifications';

/** Runs the real `storyline-spark-started` query against an in-process Postgres. */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const STARTER = 1;
const CREATOR = 2;
const LAST_SENT = '2026-11-03T10:00:00.000Z';
const AFTER = '2026-11-03 10:00:05';
const BEFORE = '2026-11-03 09:59:00';

const processor = storylineInviteNotifications['storyline-spark-started'];
let db: PGlite;

const run = async () =>
  (
    await db.query<{ key: string; userId: number; type: string; details: Record<string, unknown> }>(
      await (processor.prepareQuery as (a: { lastSent: string }) => Promise<string>)({
        lastSent: LAST_SENT,
      })
    )
  ).rows;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "User"(id int PRIMARY KEY, username text);
    CREATE TABLE "UserEngagement"("userId" int, "targetUserId" int, type text);
    CREATE TABLE "UserNotificationSettings"("userId" int, type text);
    CREATE TABLE "Image"(id int PRIMARY KEY, "userId" int,
      "tosViolation" boolean NOT NULL DEFAULT false);
    CREATE TABLE "Storyline"(id int PRIMARY KEY, "userId" int, title text, "sparkImageId" int,
      "createdAt" timestamp(3), "tosViolation" boolean NOT NULL DEFAULT false);
    CREATE TABLE "StorylineChapter"(id int PRIMARY KEY, "storylineId" int, depth int,
      "createdAt" timestamp(3), "removedAt" timestamp(3));
    INSERT INTO "User" VALUES (${STARTER}, 'starter'), (${CREATOR}, 'creator');
  `);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(`
    TRUNCATE "UserEngagement", "UserNotificationSettings", "Image", "Storyline", "StorylineChapter";
    INSERT INTO "Image" VALUES (500, ${CREATOR}, false), (501, ${STARTER}, false);
  `);
});

/** A storyline made before the last run, sparked by `imageId`. */
const story = (imageId = 500) =>
  db.exec(`INSERT INTO "Storyline" VALUES (10, ${STARTER}, 'The Patch', ${imageId}, '${BEFORE}')`);

const chapterOne = ({ createdAt = AFTER, depth = 0 } = {}) =>
  db.query(`INSERT INTO "StorylineChapter" VALUES (20, 10, $1, $2, NULL)`, [depth, createdAt]);

describe('storyline-spark-started', () => {
  it('tells the image creator once chapter 1 exists, keyed per storyline', async () => {
    expect(notificationProcessors['storyline-spark-started']).toBe(processor);
    await story();
    await chapterOne();
    const rows = await run();
    expect(rows).toEqual([
      {
        key: 'storyline-spark-started:10',
        userId: CREATOR,
        type: 'storyline-spark-started',
        details: expect.objectContaining({
          storylineId: 10,
          imageId: 500,
          ownerId: STARTER,
          ownerUsername: 'starter',
        }),
      },
    ]);
    expect(
      processor.prepareMessage({
        type: 'storyline-spark-started',
        details: rows[0].details,
      } as never)
    ).toEqual({
      message: 'starter started a story from your image: "The Patch"',
      url: '/storylines/10',
    });
  });

  it.each([
    ['chapter 1 does not exist yet', () => story()],
    [
      'chapter 1 predates the last run',
      () => story().then(() => chapterOne({ createdAt: BEFORE })),
    ],
    ['only a later chapter is new', () => story().then(() => chapterOne({ depth: 1 }))],
    ['the image is the starter’s own', () => story(501).then(() => chapterOne())],
    [
      'the storyline is taken down',
      async () => {
        await story();
        await chapterOne();
        await db.exec(`UPDATE "Storyline" SET "tosViolation" = true`);
      },
    ],
    [
      'the image is taken down',
      async () => {
        await story();
        await chapterOne();
        await db.exec(`UPDATE "Image" SET "tosViolation" = true WHERE id = 500`);
      },
    ],
    [
      'the creator blocked the starter',
      async () => {
        await story();
        await chapterOne();
        await db.exec(`INSERT INTO "UserEngagement" VALUES (${CREATOR}, ${STARTER}, 'Block')`);
      },
    ],
    [
      'the starter blocked the creator',
      async () => {
        await story();
        await chapterOne();
        await db.exec(`INSERT INTO "UserEngagement" VALUES (${STARTER}, ${CREATOR}, 'Block')`);
      },
    ],
    [
      'the creator turned this notification off',
      async () => {
        await story();
        await chapterOne();
        await db.exec(
          `INSERT INTO "UserNotificationSettings" VALUES (${CREATOR}, 'storyline-spark-started')`
        );
      },
    ],
  ])('sends nothing when %s', async (_name, setup) => {
    await setup();
    expect(await run()).toEqual([]);
  });
});
