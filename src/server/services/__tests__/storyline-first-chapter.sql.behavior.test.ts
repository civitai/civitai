import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * Choosing a post already published as an empty storyline's chapter 1, run as written against an
 * in-process Postgres built from the shipped storyline migrations.
 *
 * PGlite has one session, so nothing here interleaves two transactions. The locks against a
 * concurrent delete and a chapter-1 draft going live were checked against a real Postgres (see the PR).
 */

const { setFirstChapter } = await import('~/server/services/storyline.service');

const migration = (name: string) =>
  readFileSync(
    path.resolve(
      __dirname,
      `../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`
    ),
    'utf8'
  );

const db = { pg: null as unknown as PGlite };
const w = dbMock.dbWrite;

const OWNER = 1;
const STRANGER = 2;
const PG = 1;
const PG13 = 2;
const R = 4;
const EMPTY = 1;
const STRANGERS_STORY = 2;
const OTHER_STORY = 3;

const rows = async <T>(sql: string, params: unknown[] = []) =>
  (await db.pg.query<T>(sql, params)).rows;

let txQueue: Promise<unknown> = Promise.resolve();
const runTransaction = (fn: (tx: unknown) => Promise<unknown>) => {
  const run = txQueue.then(async () => {
    await db.pg.exec('BEGIN');
    try {
      const result = await fn(w);
      await db.pg.exec('COMMIT');
      return result;
    } catch (error) {
      await db.pg.exec('ROLLBACK');
      throw error;
    }
  });
  txQueue = run.catch(() => undefined);
  return run;
};

beforeAll(async () => {
  db.pg = new PGlite();
  await db.pg.exec(`
    CREATE TABLE "User" ("id" integer PRIMARY KEY);
    CREATE TABLE "Post" ("id" integer PRIMARY KEY, "userId" integer, "nsfwLevel" integer NOT NULL DEFAULT 0,
      "publishedAt" timestamp(3), "tosViolation" boolean NOT NULL DEFAULT false);
    CREATE TABLE "Report" ("id" integer PRIMARY KEY);
    CREATE TABLE "Image" ("id" serial PRIMARY KEY, "postId" integer, ingestion text NOT NULL DEFAULT 'Scanned',
      "needsReview" text, "tosViolation" boolean NOT NULL DEFAULT false,
      minor boolean NOT NULL DEFAULT false, poi boolean NOT NULL DEFAULT false);
  `);
  for (const name of [
    '20261023120000_storylines',
    '20261023130000_storyline_children_index',
    '20261023140000_storyline_engagement',
    '20261024120000_storyline_chapter_removed',
    '20261024150000_storyline_moderator_takedown',
    '20261024160000_storyline_minor_by_scan',
    '20261106120000_storyline_rejoin',
    '20261122120000_storyline_pending_chapter',
  ])
    await db.pg.exec(migration(name));
  await db.pg.exec(`INSERT INTO "User" (id) VALUES (1), (2);`);
});

afterAll(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  await db.pg.exec(`
    DELETE FROM "StorylinePendingChapter";
    DELETE FROM "StorylineChapterEdge";
    DELETE FROM "StorylineChapter";
    DELETE FROM "Storyline";
    DELETE FROM "Image";
    DELETE FROM "Post";
    INSERT INTO "Storyline" (id, "userId", title, "maxNsfwLevel", "updatedAt") VALUES
      (${EMPTY}, ${OWNER}, 'Nothing yet', ${PG13}, now()),
      (${STRANGERS_STORY}, ${STRANGER}, 'Not yours', ${PG13}, now()),
      (${OTHER_STORY}, ${OWNER}, 'Already going', ${PG13}, now());
    INSERT INTO "Post" (id, "userId", "nsfwLevel", "publishedAt") VALUES
      (100, ${OWNER}, ${PG}, now() - interval '1 day'),
      (101, ${OWNER}, ${PG}, now() - interval '1 day'),
      (200, ${STRANGER}, ${PG}, now() - interval '1 day');
    INSERT INTO "Image" ("postId") VALUES (100), (101), (200);
    INSERT INTO "StorylineChapter" (id, "storylineId", "postId", "userId", depth) VALUES
      (30, ${OTHER_STORY}, 101, ${OWNER}, 0);
  `);
  const raw = pgliteRaw(db.pg);
  w.$transaction.mockImplementation(runTransaction as never);
  w.$queryRaw.mockImplementation(raw.queryRaw as never);
  w.$executeRaw.mockImplementation(raw.executeRaw as never);
  w.post.findUnique.mockImplementation((async ({ where }: { where: { id: number } }) => {
    const [row] = await rows<Record<string, unknown> & { chapterId: number | null }>(
      `SELECT p."userId", p."nsfwLevel", p."publishedAt", p."tosViolation", c.id AS "chapterId"
       FROM "Post" p LEFT JOIN "StorylineChapter" c ON c."postId" = p.id WHERE p.id = $1`,
      [where.id]
    );
    if (!row) return null;
    const { chapterId, ...rest } = row;
    const images = await rows(
      `SELECT ingestion, "needsReview", "tosViolation", minor, poi FROM "Image" WHERE "postId" = $1`,
      [where.id]
    );
    return { ...rest, images, storylineChapter: chapterId ? { id: chapterId } : null };
  }) as never);
  w.storyline.update.mockImplementation(
    (async ({ where, data }: { where: { id: number }; data: { maxNsfwLevel: number } }) =>
      (
        await rows(`UPDATE "Storyline" SET "maxNsfwLevel" = $2 WHERE id = $1 RETURNING id`, [
          where.id,
          data.maxNsfwLevel,
        ])
      )[0]) as never
  );
  w.storylineChapter.create.mockImplementation(
    (async ({
      data,
    }: {
      data: { storylineId: number; postId: number; userId: number; depth: number };
    }) =>
      (
        await rows(
          `INSERT INTO "StorylineChapter" ("storylineId", "postId", "userId", depth)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [data.storylineId, data.postId, data.userId, data.depth]
        )
      )[0]) as never
  );
});

const chaptersOf = (storylineId: number) =>
  rows<{ postId: number; depth: number }>(
    `SELECT "postId", depth FROM "StorylineChapter" WHERE "storylineId" = $1 ORDER BY id`,
    [storylineId]
  );
const ceilingOf = async (storylineId: number) =>
  (
    await rows<{ maxNsfwLevel: number }>(`SELECT "maxNsfwLevel" FROM "Storyline" WHERE id = $1`, [
      storylineId,
    ])
  )[0].maxNsfwLevel;

const attach = (postId: number, storylineId = EMPTY, userId = OWNER) =>
  setFirstChapter({ storylineId, postId, userId });

describe('setFirstChapter', () => {
  it("makes the owner's published post chapter 1 of their empty storyline", async () => {
    const result = await attach(100);

    expect(result).toMatchObject({ storylineId: EMPTY, ceilingRaisedTo: undefined });
    expect(await chaptersOf(EMPTY)).toEqual([{ postId: 100, depth: 0 }]);
    expect(await ceilingOf(EMPTY)).toBe(PG13);
  });

  it('refuses a storyline that already has a chapter', async () => {
    await expect(attach(100, OTHER_STORY)).rejects.toThrow(
      'This storyline already has its first chapter'
    );
    expect(await chaptersOf(OTHER_STORY)).toEqual([{ postId: 101, depth: 0 }]);
  });

  // A removed chapter keeps its row, and chapter 1 is still taken.
  it('refuses a storyline whose only chapter is a tombstone', async () => {
    await db.pg.exec(`
      INSERT INTO "StorylineChapter" (id, "storylineId", "postId", "userId", depth, "removedAt")
      VALUES (40, ${EMPTY}, NULL, ${OWNER}, 0, now())
    `);
    await expect(attach(100)).rejects.toThrow('This storyline already has its first chapter');
  });

  // Its draft would be written over this one when it publishes.
  it('refuses a storyline with a chapter-1 draft', async () => {
    await db.pg.exec(`
      INSERT INTO "Post" (id, "userId") VALUES (300, ${OWNER});
      INSERT INTO "StorylinePendingChapter" ("postId", "storylineId", "userId")
      VALUES (300, ${EMPTY}, ${OWNER});
    `);
    await expect(attach(100)).rejects.toThrow(
      'This storyline already has a draft of its first chapter'
    );
    expect(await chaptersOf(EMPTY)).toEqual([]);
  });

  it("refuses someone else's storyline", async () => {
    await expect(attach(200, STRANGERS_STORY, OWNER)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: "Only the storyline's creator can choose its first chapter",
    });
    expect(await chaptersOf(STRANGERS_STORY)).toEqual([]);
  });

  it("refuses the owner's post on someone else's storyline", async () => {
    await expect(attach(100, STRANGERS_STORY, OWNER)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(await chaptersOf(STRANGERS_STORY)).toEqual([]);
  });

  it("refuses someone else's post", async () => {
    await expect(attach(200)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'You can only add your own posts',
    });
    expect(await chaptersOf(EMPTY)).toEqual([]);
  });

  it('refuses a post that is already a chapter', async () => {
    await expect(attach(101)).rejects.toThrow('This post is already in a storyline');
    expect(await chaptersOf(EMPTY)).toEqual([]);
  });

  it('refuses an unpublished post, and a scheduled one', async () => {
    await db.pg.exec(`
      INSERT INTO "Post" (id, "userId", "nsfwLevel", "publishedAt") VALUES
        (102, ${OWNER}, ${PG}, NULL), (103, ${OWNER}, ${PG}, now() + interval '1 day');
    `);
    for (const postId of [102, 103])
      await expect(attach(postId)).rejects.toThrow(
        'Publish the post before adding it to a storyline'
      );
    expect(await chaptersOf(EMPTY)).toEqual([]);
  });

  // Its rating, and so the ceiling it raises, can still change.
  it.each([
    ['an image still scanning', `ingestion = 'Pending'`],
    ['an image in review', `"needsReview" = 'minor'`],
  ])('refuses a post with %s, changing nothing', async (_, set) => {
    await db.pg.exec(`
      UPDATE "Post" SET "nsfwLevel" = ${R} WHERE id = 100;
      INSERT INTO "Image" ("postId") VALUES (100);
      UPDATE "Image" SET ${set} WHERE id = (SELECT max(id) FROM "Image");
    `);
    await expect(attach(100)).rejects.toThrow("This post's images are still being checked");
    expect(await ceilingOf(EMPTY)).toBe(PG13);
    expect(await chaptersOf(EMPTY)).toEqual([]);
  });

  it('refuses a post with an image taken down', async () => {
    await db.pg.exec(`UPDATE "Image" SET "tosViolation" = true WHERE "postId" = 100`);
    await expect(attach(100)).rejects.toThrow(
      "This post or one of its images can't be used in a storyline"
    );
    expect(await chaptersOf(EMPTY)).toEqual([]);
  });

  it('refuses a taken-down post', async () => {
    await db.pg.exec(`UPDATE "Post" SET "tosViolation" = true WHERE id = 100`);
    await expect(attach(100)).rejects.toThrow(
      "This post or one of its images can't be used in a storyline"
    );
    expect(await chaptersOf(EMPTY)).toEqual([]);
  });

  it('refuses a taken-down storyline', async () => {
    await db.pg.exec(`UPDATE "Storyline" SET "tosViolation" = true WHERE id = ${EMPTY}`);
    await expect(attach(100)).rejects.toThrow('This storyline was taken down');
    expect(await chaptersOf(EMPTY)).toEqual([]);
  });

  // As a chapter-1 draft does on publish: the owner set the ceiling before choosing chapter 1.
  it('raises the ceiling to fit a post rated above it', async () => {
    await db.pg.exec(`UPDATE "Post" SET "nsfwLevel" = ${PG | R} WHERE id = 100`);

    await expect(attach(100)).resolves.toMatchObject({ ceilingRaisedTo: R });

    expect(await ceilingOf(EMPTY)).toBe(R);
    expect(await chaptersOf(EMPTY)).toEqual([{ postId: 100, depth: 0 }]);
  });

  it('refuses a post over a ceiling that cannot be raised to fit it, changing nothing', async () => {
    await db.pg.exec(`
      UPDATE "Post" SET "nsfwLevel" = ${R} WHERE id = 100;
      UPDATE "Storyline" SET "minorByScan" = true WHERE id = ${EMPTY};
    `);

    await expect(attach(100)).rejects.toThrow(
      "This post is rated above this storyline's maximum. This storyline allows up to PG-13; this post is R"
    );
    expect(await ceilingOf(EMPTY)).toBe(PG13);
    expect(await chaptersOf(EMPTY)).toEqual([]);
  });

  it('says not found for a storyline that is gone', async () => {
    await expect(attach(100, 999)).rejects.toThrow('Storyline not found');
  });
});
