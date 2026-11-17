import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { userImageVideoCountQuery } from '~/server/redis/user-image-video-count.sql';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const USER = 7;
const SFW = 1;
const NSFW = 4;
const PAST = new Date(Date.now() - 60 * 60_000);

const pg = { db: null as unknown as PGlite };

beforeAll(async () => {
  pg.db = new PGlite();
  await pg.db.exec(`
    CREATE FUNCTION iif(condition boolean, true_result anyelement, false_result anyelement)
      RETURNS anyelement LANGUAGE sql IMMUTABLE AS
      'SELECT CASE WHEN condition THEN true_result ELSE false_result END';
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int NOT NULL, "publishedAt" timestamp(3),
      availability text NOT NULL DEFAULT 'Public'
    );
    CREATE TABLE "Image" (
      id serial PRIMARY KEY, "userId" int NOT NULL, "postId" int REFERENCES "Post"(id),
      type text NOT NULL DEFAULT 'image', ingestion text NOT NULL DEFAULT 'Scanned',
      "needsReview" text, "nsfwLevel" int NOT NULL DEFAULT ${SFW}
    );
  `);
});

afterAll(async () => {
  await pg.db?.close();
});

beforeEach(async () => {
  await pg.db.exec('TRUNCATE "Image", "Post"');
  await pg.db.query(`INSERT INTO "Post" (id, "userId", "publishedAt") VALUES (1, $1, $2)`, [
    USER,
    PAST,
  ]);
  await pg.db.query(`INSERT INTO "Image" ("userId", "postId") VALUES ($1, 1)`, [USER]);
  // An image that belongs to no post, as an App Block upload does.
  await pg.db.query(`INSERT INTO "Image" ("userId", "postId") VALUES ($1, NULL)`, [USER]);
});

const imageCount = async (browsingLevelsFlag?: number) => {
  const rows = (await pgliteRaw(pg.db).queryRaw(
    userImageVideoCountQuery([USER], browsingLevelsFlag)
  )) as { imageCount: number }[];
  return rows[0]?.imageCount ?? 0;
};

describe('userImageVideoCountQuery', () => {
  it('leaves out a postless image when the user has no unpublished post', async () => {
    expect(await imageCount()).toBe(1);
  });

  it('leaves out postless and draft-post images when the user has a draft post', async () => {
    await pg.db.query(`INSERT INTO "Post" (id, "userId", "publishedAt") VALUES (2, $1, NULL)`, [
      USER,
    ]);
    await pg.db.query(`INSERT INTO "Image" ("userId", "postId") VALUES ($1, 2)`, [USER]);
    expect(await imageCount()).toBe(1);
  });

  it('leaves out a postless image in a browsing-level variant', async () => {
    await pg.db.query(`INSERT INTO "Image" ("userId", "postId", "nsfwLevel") VALUES ($1, 1, $2)`, [
      USER,
      NSFW,
    ]);
    expect(await imageCount(SFW)).toBe(1);
    expect(await imageCount()).toBe(2);
  });
});
