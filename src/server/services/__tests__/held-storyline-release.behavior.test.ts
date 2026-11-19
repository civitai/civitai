import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  heldCopiesSchemaSql,
  heldStorylineCopiesSchemaSql,
} from '~/server/services/__tests__/held-copies.fixture';
import { purgeReleasedHeldCopies } from '~/server/services/held-review.service';

/**
 * The daily purge of a deleted storyline's copy (`deleteStoryline`): kept for a year after the
 * delete, and after that while its owner, any chapter author or any draft author is held, or a report
 * on it is open, read at run time. A held commenter keeps nothing: comments are not held.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const OWNER = 1;
const AUTHOR = 2;
const COMMENTER = 3;
const DRAFTER = 4; // wrote a chapter-1 draft the delete unlinked
const SENT_LONG_AGO = 6; // named on a report sent and archived over a year ago

let db: PGlite;
const asSql = (first: TemplateStringsArray | Prisma.Sql, values: unknown[]) =>
  Array.isArray(first)
    ? Prisma.sql(first as TemplateStringsArray, ...(values as never[]))
    : (first as Prisma.Sql);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY, "userId" int, "reportSentAt" timestamp(3), "archivedAt" timestamp(3),
      details jsonb NOT NULL DEFAULT '{}', images jsonb NOT NULL DEFAULT '[]'
    );
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, "needsReview" text, "blockedFor" text
    );
    CREATE TABLE "EvidenceHold" ("userId" int NOT NULL);
    CREATE VIEW "EvidenceHeldUser" AS SELECT "userId" FROM "EvidenceHold";
  `);
  await db.exec(heldCopiesSchemaSql());
  await db.exec(heldStorylineCopiesSchemaSql());
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await db.exec(`
    TRUNCATE "CsamReport", "EvidenceHold", "HeldStoryline", "HeldStorylineChapter",
      "HeldStorylineChapterEdge", "HeldStorylineBranchChoice", "HeldStorylineCreateClick",
      "StorylineReport", "Report";
    INSERT INTO "HeldStoryline" (id, "userId", title, "createdAt", "deletedAt", "deletedById",
      "commenterIds", "pendingAuthorIds")
      VALUES (1, ${OWNER}, 'Kept', now(), now() - interval '400 days', ${OWNER}, ARRAY[${COMMENTER}],
        ARRAY[${DRAFTER}]);
    INSERT INTO "HeldStorylineChapter" (id, "storylineId", "userId", depth, "createdAt", "ownerId",
      "authorId") VALUES (10, 1, ${OWNER}, 0, now(), ${OWNER}, ${OWNER}),
      (11, 1, ${AUTHOR}, 1, now(), ${OWNER}, ${AUTHOR});
    INSERT INTO "HeldStorylineChapterEdge" ("storylineId", "chapterId", "parentChapterId", canon,
      "createdAt", "ownerId", "authorId") VALUES (1, 11, 10, true, now(), ${OWNER}, ${AUTHOR});
    INSERT INTO "HeldStorylineBranchChoice" ("userId", "parentChapterId", "chapterId", "createdAt",
      "updatedAt", "ownerId", "authorId") VALUES (99, 10, 11, now(), now(), ${OWNER}, ${AUTHOR});
    INSERT INTO "HeldStorylineCreateClick" ("userId", "parentChapterId", "createdAt", "ownerId",
      "authorId") VALUES (99, 11, now(), ${OWNER}, ${AUTHOR});
  `);
  dbMock.dbWrite.$queryRaw.mockImplementation((async (first: never, ...values: unknown[]) => {
    const query = asSql(first, values);
    return (await db.query(query.text, query.values as unknown[])).rows;
  }) as never);
  dbMock.dbWrite.$executeRaw.mockImplementation((async (first: never, ...values: unknown[]) => {
    const query = asSql(first, values);
    return (await db.query(query.text, query.values as unknown[])).affectedRows ?? 0;
  }) as never);
});

const left = async () => ({
  storylines: (await db.query(`SELECT id FROM "HeldStoryline"`)).rows.length,
  chapters: (await db.query(`SELECT id FROM "HeldStorylineChapter"`)).rows.length,
  edges: (await db.query(`SELECT 1 FROM "HeldStorylineChapterEdge"`)).rows.length,
  choices: (await db.query(`SELECT 1 FROM "HeldStorylineBranchChoice"`)).rows.length,
  clicks: (await db.query(`SELECT 1 FROM "HeldStorylineCreateClick"`)).rows.length,
});
const all = { storylines: 1, chapters: 2, edges: 1, choices: 1, clicks: 1 };
const none = { storylines: 0, chapters: 0, edges: 0, choices: 0, clicks: 0 };
const hold = (userId: number) => db.exec(`INSERT INTO "EvidenceHold" VALUES (${userId})`);

describe('purgeReleasedHeldCopies on a deleted storyline', () => {
  it('releases the copy and every chapter copy once nobody is held and no report is open', async () => {
    expect(await purgeReleasedHeldCopies()).toMatchObject({
      storylines: 1,
      storyline: { chapters: 2, edges: 1, choices: 1, clicks: 1 },
    });
    expect(await left()).toEqual(none);
  });

  for (const [who, userId] of [
    ['its owner', OWNER],
    ['a chapter author', AUTHOR],
    ["a draft's author", DRAFTER],
  ] as const)
    it(`keeps it all while ${who} is held, and releases it once they are not`, async () => {
      await hold(userId);
      await purgeReleasedHeldCopies();
      expect(await left()).toEqual(all);
      await db.exec(`TRUNCATE "EvidenceHold"`);
      await purgeReleasedHeldCopies();
      expect(await left()).toEqual(none);
    });

  it('releases it while a commenter is held', async () => {
    await hold(COMMENTER);
    await purgeReleasedHeldCopies();
    expect(await left()).toEqual(none);
  });

  it('keeps it while a report linked to the copy is open', async () => {
    await db.exec(`
      INSERT INTO "Report" (id, status) VALUES (70, 'Pending');
      INSERT INTO "StorylineReport" ("reportId", "storylineId", "heldStorylineId") VALUES (70, NULL, 1);
    `);
    await purgeReleasedHeldCopies();
    expect(await left()).toEqual(all);
    await db.exec(`UPDATE "Report" SET status = 'Actioned' WHERE id = 70`);
    await purgeReleasedHeldCopies();
    expect(await left()).toEqual(none);
  });

  it('keeps it while a report it recorded is open', async () => {
    await db.exec(`
      INSERT INTO "Report" (id, status) VALUES (71, 'Processing');
      UPDATE "HeldStoryline" SET "reportIds" = ARRAY[71];
    `);
    await purgeReleasedHeldCopies();
    expect(await left()).toEqual(all);
    await db.exec(`UPDATE "Report" SET status = 'Unactioned' WHERE id = 71`);
    await purgeReleasedHeldCopies();
    expect(await left()).toEqual(none);
  });

  it('keeps a copy deleted under a year ago even when nothing else keeps it', async () => {
    await db.exec(`UPDATE "HeldStoryline" SET "deletedAt" = now() - interval '300 days'`);
    await purgeReleasedHeldCopies();
    expect(await left()).toEqual(all);
  });

  it('keeps a copy deleted under a year ago after its open report is resolved', async () => {
    await db.exec(`
      INSERT INTO "Report" (id, status) VALUES (72, 'Pending');
      UPDATE "HeldStoryline" SET "reportIds" = ARRAY[72], "deletedAt" = now() - interval '1 day';
    `);
    await purgeReleasedHeldCopies();
    await db.exec(`UPDATE "Report" SET status = 'Unactioned' WHERE id = 72`);
    await purgeReleasedHeldCopies();
    expect(await left()).toEqual(all);
  });

  it('releases a hold that lapsed after a year, as every other copy does', async () => {
    await db.exec(`
      INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt")
        VALUES (${SENT_LONG_AGO}, now() - interval '400 days', now() - interval '400 days');
      UPDATE "HeldStoryline" SET "userId" = ${SENT_LONG_AGO};
    `);
    await purgeReleasedHeldCopies();
    expect(await left()).toEqual(none);
  });

  // The chapter copies alone would be released: none of their owners or authors is held.
  it('keeps its chapter copies with it while only an open report keeps it', async () => {
    await db.exec(`
      INSERT INTO "Report" (id, status) VALUES (70, 'Pending');
      UPDATE "HeldStoryline" SET "reportIds" = ARRAY[70];
    `);
    expect(await purgeReleasedHeldCopies()).toMatchObject({
      storylines: 0,
      storyline: { chapters: 0, edges: 0, choices: 0, clicks: 0 },
    });
    expect(await left()).toEqual(all);
  });

  it("leaves another storyline's chapter copies alone", async () => {
    await hold(OWNER);
    await db.exec(`
      INSERT INTO "HeldStoryline" (id, "userId", title, "createdAt", "deletedAt", "deletedById")
        VALUES (2, 50, 'Free', now(), now() - interval '400 days', 50);
      INSERT INTO "HeldStorylineChapter" (id, "storylineId", "userId", depth, "createdAt", "ownerId",
        "authorId") VALUES (20, 2, 50, 0, now(), 50, 50);
    `);
    await purgeReleasedHeldCopies();
    expect(await left()).toEqual(all);
  });
});
