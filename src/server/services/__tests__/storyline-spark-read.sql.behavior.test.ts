import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { NsfwLevel } from '~/server/common/enums';
import type { StorylineImageGate } from '~/server/services/storyline.service';
import { getStorylineSpark } from '~/server/services/storyline.service';

/**
 * Whether a storyline's spark credit is shown, run as written against an in-process Postgres built
 * from the shipped storyline migrations and the spark migration. Every case but the control hides
 * the credit; the story itself is not under test.
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
const READER = 3;
const STORY = 10;
const SPARK = 500;
const ALL_LEVELS = 31;

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
      url text NOT NULL DEFAULT 'spark-url', type text NOT NULL DEFAULT 'image',
      "nsfwLevel" integer NOT NULL DEFAULT 1, hash text, width integer, height integer,
      "tosViolation" boolean NOT NULL DEFAULT false, minor boolean NOT NULL DEFAULT false,
      "acceptableMinor" boolean NOT NULL DEFAULT false, poi boolean NOT NULL DEFAULT false,
      ingestion text NOT NULL DEFAULT 'Scanned', "needsReview" text);
    CREATE TABLE "TagsOnImageDetails" ("imageId" integer, "tagId" integer,
      disabled boolean NOT NULL DEFAULT false);
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
  dbMock.dbRead.$queryRaw.mockImplementation(raw.queryRaw as never);
  await db.pg.exec(`
    TRUNCATE "User", "Post", "Image", "TagsOnImageDetails", "Storyline" CASCADE;
    INSERT INTO "User" (id, username) VALUES (1, 'creator'), (2, 'starter'), (3, 'reader');
    INSERT INTO "Post" (id, "userId", "publishedAt") VALUES (50, ${CREATOR}, now() - interval '1 day');
    INSERT INTO "Image" (id, "postId", "userId", "nsfwLevel")
      VALUES (${SPARK}, 50, ${CREATOR}, ${NsfwLevel.R});
    INSERT INTO "Storyline" (id, "userId", title, "maxNsfwLevel", "sparkImageId", "updatedAt")
      VALUES (${STORY}, ${STARTER}, 'A story', ${NsfwLevel.R}, ${SPARK}, now());
  `);
});

const gate = (viewerId = READER): StorylineImageGate => ({
  viewer: { id: viewerId },
  browsingLevel: ALL_LEVELS,
  blockedUserIds: new Set(),
  hiddenImageIds: [],
  hiddenTagIds: [],
});

const read = (viewerId = READER) => getStorylineSpark(async () => gate(viewerId), STORY, SPARK);

describe("a storyline's spark credit", () => {
  it('is shown for a published, rated image within the ceiling (control)', async () => {
    await expect(read()).resolves.toEqual({
      image: expect.objectContaining({ id: SPARK, url: 'spark-url', nsfwLevel: NsfwLevel.R }),
      user: { id: CREATOR, username: 'creator' },
    });
  });

  it.each([
    ['its post is unpublished', `UPDATE "Post" SET "publishedAt" = NULL`],
    ['its post is scheduled', `UPDATE "Post" SET "publishedAt" = now() + interval '1 day'`],
    ['its post is taken down', `UPDATE "Post" SET "tosViolation" = true`],
    ['its creator is banned', `UPDATE "User" SET "bannedAt" = now() WHERE id = ${CREATOR}`],
    ['its creator is deleted', `UPDATE "User" SET "deletedAt" = now() WHERE id = ${CREATOR}`],
    ['the image is taken down', `UPDATE "Image" SET "tosViolation" = true`],
    ['the image is above the story ceiling', `UPDATE "Image" SET "nsfwLevel" = ${NsfwLevel.X}`],
    ['its post is private', `UPDATE "Post" SET availability = 'Private'`],
  ])('is hidden when %s', async (_name, change) => {
    await db.pg.exec(change);
    await expect(read()).resolves.toBeNull();
  });

  it("is shown to the image's own creator on a private post", async () => {
    await db.pg.exec(`UPDATE "Post" SET availability = 'Private'`);
    await expect(read(CREATOR)).resolves.not.toBeNull();
  });
});
