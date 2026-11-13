import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { NsfwLevel } from '~/server/common/enums';
import { findUnwrittenSparkStoryline } from '~/server/services/storyline.service';

/**
 * Which storyline a second start from the same image reuses, run as written against an
 * in-process Postgres built from the shipped storyline migrations.
 */

const db = { pg: null as unknown as PGlite };

const migration = (name: string) =>
  readFileSync(
    path.resolve(
      __dirname,
      `../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`
    ),
    'utf8'
  );

const CREATOR = 1;
const STARTER = 2;
const OTHER = 3;
const SPARK = 500;
const OTHER_IMAGE = 501;
const STORY = 10;

beforeAll(async () => {
  db.pg = new PGlite();
  await db.pg.exec(`
    CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
    CREATE TABLE "User" (id integer PRIMARY KEY, username text, "bannedAt" timestamp(3),
      "deletedAt" timestamp(3));
    CREATE TABLE "Post" (id integer PRIMARY KEY, "userId" integer, "nsfwLevel" integer NOT NULL DEFAULT 1,
      "publishedAt" timestamp(3), "tosViolation" boolean NOT NULL DEFAULT false,
      availability "Availability" NOT NULL DEFAULT 'Public');
    CREATE TABLE "Report" (id integer PRIMARY KEY);
    CREATE TABLE "Image" (id integer PRIMARY KEY, "postId" integer, "userId" integer,
      "nsfwLevel" integer NOT NULL DEFAULT 1);
  `);
  for (const name of [
    '20261023120000_storylines',
    '20261023130000_storyline_children_index',
    '20261023140000_storyline_engagement',
    '20261024120000_storyline_chapter_removed',
    '20261024130000_storyline_cover_hero',
    '20261024140000_storyline_title_moderation',
    '20261024150000_storyline_moderator_takedown',
    '20261024160000_storyline_minor_by_scan',
    '20261220120000_storyline_spark_image',
  ])
    await db.pg.exec(migration(name));
});

afterAll(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  const raw = pgliteRaw(db.pg);
  dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
  await db.pg.exec(`
    TRUNCATE "User", "Post", "Image", "Storyline" CASCADE;
    INSERT INTO "User" (id, username) VALUES (1, 'creator'), (2, 'starter'), (3, 'other');
    INSERT INTO "Post" (id, "userId", "publishedAt") VALUES
      (50, ${CREATOR}, now() - interval '1 day'), (60, ${STARTER}, now() - interval '1 hour');
    INSERT INTO "Image" (id, "postId", "userId", "nsfwLevel") VALUES
      (${SPARK}, 50, ${CREATOR}, ${NsfwLevel.R}), (${OTHER_IMAGE}, 50, ${CREATOR}, ${NsfwLevel.R});
    INSERT INTO "Storyline" (id, "userId", title, "maxNsfwLevel", "sparkImageId", "updatedAt")
      VALUES (${STORY}, ${STARTER}, 'A story', ${NsfwLevel.R}, ${SPARK}, now());
  `);
});

const find = (userId = STARTER, sparkImageId = SPARK) =>
  findUnwrittenSparkStoryline({ userId, sparkImageId });

describe('the storyline a second start from the same image reuses', () => {
  it("is the starter's own storyline from that image with no chapter 1 (control)", async () => {
    await expect(find()).resolves.toEqual({ id: STORY, title: 'A story' });
  });

  it('is the newest when there are several', async () => {
    await db.pg.exec(`
      INSERT INTO "Storyline" (id, "userId", title, "maxNsfwLevel", "sparkImageId", "updatedAt")
        VALUES (11, ${STARTER}, 'Again', ${NsfwLevel.R}, ${SPARK}, now());
    `);
    await expect(find()).resolves.toEqual({ id: 11, title: 'Again' });
  });

  it.each([
    [
      'chapter 1 is written',
      `INSERT INTO "StorylineChapter" ("storylineId", "postId", "userId", depth)
         VALUES (${STORY}, 60, ${STARTER}, 0)`,
    ],
    [
      'chapter 1 was written and then removed',
      `INSERT INTO "StorylineChapter" ("storylineId", "postId", "userId", depth, "removedAt")
         VALUES (${STORY}, 60, ${STARTER}, 0, now())`,
    ],
    ['it was taken down', `UPDATE "Storyline" SET "tosViolation" = true`],
  ])('is none when %s', async (_name, sql) => {
    await db.pg.exec(sql);
    await expect(find()).resolves.toBeNull();
  });

  it("is none for another user's storyline from the same image", async () => {
    await expect(find(OTHER)).resolves.toBeNull();
  });

  it('is none for a storyline from a different image', async () => {
    await expect(find(STARTER, OTHER_IMAGE)).resolves.toBeNull();
  });
});
