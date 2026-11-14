import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import { ratedEntityContentNsfwLevelText } from '@civitai/shared/rated-entity-sql';

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Post" (id int PRIMARY KEY);
    CREATE TABLE "Image" (id serial PRIMARY KEY, "postId" int, "nsfwLevel" int NOT NULL);
    CREATE TABLE "PostText" (
      id serial PRIMARY KEY, "postId" int NOT NULL, "nsfwLevel" int NOT NULL DEFAULT 0,
      refused boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "EntityModeration" (
      "entityType" text, "entityId" int, "nsfwLevel" int, result jsonb
    );
  `);
});
afterAll(() => db.close());
beforeEach(async () => {
  await db.exec(`TRUNCATE "Post", "Image", "PostText", "EntityModeration";
    INSERT INTO "Post" (id) VALUES (1);
    INSERT INTO "Image" ("postId", "nsfwLevel") VALUES (1, ${NsfwLevel.PG}), (1, ${NsfwLevel.PG});`);
});

const level = async () => {
  const { rows } = await db.query<{ l: number }>(
    `SELECT ${ratedEntityContentNsfwLevelText('Post', 'p')} AS l FROM "Post" p WHERE p.id = 1`
  );
  return rows[0].l;
};

describe("a post's storyline text rates it as its images do", () => {
  it('XXX text on PG images rates the post XXX, and deleting the text drops it back', async () => {
    expect(await level()).toBe(NsfwLevel.PG);
    await db.exec(`INSERT INTO "PostText" ("postId", "nsfwLevel") VALUES (1, ${NsfwLevel.XXX})`);
    expect(await level()).toBe(NsfwLevel.PG | NsfwLevel.XXX);
    await db.exec(`DELETE FROM "PostText"`);
    expect(await level()).toBe(NsfwLevel.PG);
  });

  it('a refused text does not rate the post; an unscanned one adds nothing', async () => {
    await db.exec(`INSERT INTO "PostText" ("postId", "nsfwLevel", refused)
      VALUES (1, ${NsfwLevel.XXX}, true), (1, 0, false)`);
    expect(await level()).toBe(NsfwLevel.PG);
  });

  it('a post with no images stays unrated, whatever its text; one image and it takes both', async () => {
    await db.exec(`DELETE FROM "Image";
      INSERT INTO "PostText" ("postId", "nsfwLevel") VALUES (1, ${NsfwLevel.XXX})`);
    expect(await level()).toBe(0);
    await db.exec(`INSERT INTO "Image" ("postId", "nsfwLevel") VALUES (1, ${NsfwLevel.PG})`);
    expect(await level()).toBe(NsfwLevel.PG | NsfwLevel.XXX);
  });

  it('a text does not lift a post whose images are all Blocked off exactly Blocked', async () => {
    await db.exec(`UPDATE "Image" SET "nsfwLevel" = ${NsfwLevel.Blocked};
      INSERT INTO "PostText" ("postId", "nsfwLevel") VALUES (1, ${NsfwLevel.R})`);
    expect(await level()).toBe(NsfwLevel.Blocked);
  });
});
